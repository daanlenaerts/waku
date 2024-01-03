// This file can depend on Node.js

import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import { Server } from 'node:http';
import type { TransferListItem } from 'node:worker_threads';
import { createServer as createViteServer } from 'vite';

import type { EntriesDev } from '../../server.js';
import type { ResolvedConfig } from '../config.js';
import { joinPath, fileURLToFilePath } from '../utils/path.js';
import { deepFreeze, hasStatusCode } from '../renderers/utils.js';
import type {
  MessageReq,
  MessageRes,
  RenderRequest,
} from './dev-worker-api.js';
import { renderRsc, getSsrConfig } from '../renderers/rsc-renderer.js';
import { nonjsResolvePlugin } from '../plugins/vite-plugin-nonjs-resolve.js';
import { rscTransformPlugin } from '../plugins/vite-plugin-rsc-transform.js';
import { rscEnvPlugin } from '../plugins/vite-plugin-rsc-env.js';
import { rscReloadPlugin } from '../plugins/vite-plugin-rsc-reload.js';
import { rscDelegatePlugin } from '../plugins/vite-plugin-rsc-delegate.js';
import { mergeUserViteConfig } from '../utils/merge-vite-config.js';

const { default: module } = await import('node:module');
const HAS_MODULE_REGISTER = typeof module.register === 'function';
if (HAS_MODULE_REGISTER) {
  module.register('waku/node-loader', pathToFileURL('./'));
}

(globalThis as any).__WAKU_PRIVATE_ENV__ = JSON.parse(
  process.env.__WAKU_PRIVATE_ENV__!,
);

const handleRender = async (mesg: MessageReq & { type: 'render' }) => {
  const { id, type: _removed, hasModuleIdCallback, ...rest } = mesg;
  const rr: RenderRequest = rest;
  try {
    if (hasModuleIdCallback) {
      rr.moduleIdCallback = (moduleId: string) => {
        const mesg: MessageRes = { id, type: 'moduleId', moduleId };
        parentPort!.postMessage(mesg);
      };
    }
    const readable = await renderRsc({
      config: rr.config,
      input: rr.input,
      searchParams: new URLSearchParams(rr.searchParamsString),
      method: rr.method,
      context: rr.context,
      body: rr.stream,
      contentType: rr.contentType,
      moduleIdCallback: rr.moduleIdCallback,
      isDev: true,
      customImport: loadServerFile,
      entries: await loadEntries(rr.config),
    });
    const mesg: MessageRes = {
      id,
      type: 'start',
      context: rr.context,
      stream: readable,
    };
    parentPort!.postMessage(mesg, [readable as unknown as TransferListItem]);
    deepFreeze(rr.context);
  } catch (err) {
    const mesg: MessageRes = { id, type: 'err', err };
    if (hasStatusCode(err)) {
      mesg.statusCode = err.statusCode;
    }
    parentPort!.postMessage(mesg);
  }
};

const handleGetSsrConfig = async (
  mesg: MessageReq & { type: 'getSsrConfig' },
) => {
  const { id, config, pathname, searchParamsString } = mesg;
  const searchParams = new URLSearchParams(searchParamsString);
  try {
    const ssrConfig = await getSsrConfig({
      config,
      pathname,
      searchParams,
      isDev: true,
      entries: await loadEntries(config),
    });
    const mesg: MessageRes = ssrConfig
      ? { id, type: 'ssrConfig', ...ssrConfig }
      : { id, type: 'noSsrConfig' };
    parentPort!.postMessage(
      mesg,
      ssrConfig ? [ssrConfig.body as unknown as TransferListItem] : undefined,
    );
  } catch (err) {
    const mesg: MessageRes = { id, type: 'err', err };
    if (hasStatusCode(err)) {
      mesg.statusCode = err.statusCode;
    }
    parentPort!.postMessage(mesg);
  }
};

const dummyServer = new Server(); // FIXME we hope to avoid this hack

const moduleImports: Set<string> = new Set();

const mergedViteConfig = await mergeUserViteConfig({
  plugins: [
    nonjsResolvePlugin(),
    rscTransformPlugin({ isBuild: false }),
    rscEnvPlugin({}),
    rscReloadPlugin(moduleImports, (type) => {
      const mesg: MessageRes = { type };
      parentPort!.postMessage(mesg);
    }),
    rscDelegatePlugin(moduleImports, (resultOrSource) => {
      const mesg: MessageRes =
        typeof resultOrSource === 'object'
          ? { type: 'module-import', result: resultOrSource }
          : { type: 'hot-import', source: resultOrSource };
      parentPort!.postMessage(mesg);
    }),
  ],
  // HACK to suppress 'Skipping dependency pre-bundling' warning
  optimizeDeps: { include: [] },
  ssr: {
    resolve: {
      conditions: ['react-server', 'workerd'],
      externalConditions: ['react-server', 'workerd'],
    },
    external: ['react', 'react-server-dom-webpack'],
    noExternal: /^(?!node:)/,
  },
  appType: 'custom',
  server: { middlewareMode: true, hmr: { server: dummyServer } },
});

const vitePromise = createViteServer(mergedViteConfig).then(async (vite) => {
  await vite.ws.close();
  return vite;
});

const loadServerFile = async (fileURL: string) => {
  const vite = await vitePromise;
  return vite.ssrLoadModule(fileURLToFilePath(fileURL));
};

const loadEntries = async (config: ResolvedConfig) => {
  const vite = await vitePromise;
  const filePath = joinPath(vite.config.root, config.srcDir, config.entriesJs);
  return vite.ssrLoadModule(filePath) as Promise<EntriesDev>;
};

parentPort!.on('message', (mesg: MessageReq) => {
  if (mesg.type === 'render') {
    handleRender(mesg);
  } else if (mesg.type === 'getSsrConfig') {
    handleGetSsrConfig(mesg);
  }
});