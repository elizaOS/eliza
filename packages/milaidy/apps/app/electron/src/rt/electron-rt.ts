import { randomBytes } from 'crypto';
import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron';
import { EventEmitter } from 'events';

////////////////////////////////////////////////////////

/** Type-safe IPC value that can be serialized across the Electron bridge */
type IpcSerializable = string | number | boolean | null | undefined | IpcSerializable[] | { [key: string]: IpcSerializable };

/** Listener callback type for IPC events */
type IpcEventListener = (...args: IpcSerializable[]) => void;

/** Plugin method signature for invocable functions */
type PluginMethod = (...args: IpcSerializable[]) => Promise<IpcSerializable>;

/** Listener entry stored in the registry */
interface ListenerEntry {
  type: string;
  listener: (event: IpcRendererEvent, ...args: IpcSerializable[]) => void;
}

/** Plugin class prototype shape from electron-plugins */
interface PluginClassPrototype {
  prototype: object;
}

/** Plugin module shape from electron-plugins */
interface PluginModule {
  [className: string]: PluginClassPrototype;
  default?: PluginClassPrototype;
}

/** Plugins registry shape */
interface PluginsRegistry {
  [pluginKey: string]: PluginModule;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugins: PluginsRegistry = require('./electron-plugins');

const randomId = (length = 5): string => randomBytes(length).toString('hex');

const contextApi: {
  [plugin: string]: { [functionName: string]: PluginMethod };
} = {};

Object.keys(plugins).forEach((pluginKey) => {
  Object.keys(plugins[pluginKey])
    .filter((className) => className !== 'default')
    .forEach((classKey) => {
      const classPrototype = plugins[pluginKey][classKey].prototype;
      const functionList = Object.getOwnPropertyNames(classPrototype).filter(
        (v) => v !== 'constructor'
      );

      if (!contextApi[classKey]) {
        contextApi[classKey] = {};
      }

      functionList.forEach((functionName) => {
        if (!contextApi[classKey][functionName]) {
          contextApi[classKey][functionName] = (...args: IpcSerializable[]): Promise<IpcSerializable> =>
            ipcRenderer.invoke(`${classKey}-${functionName}`, ...args) as Promise<IpcSerializable>;
        }
      });

      // Events
      if (classPrototype instanceof EventEmitter) {
        const listeners: { [key: string]: ListenerEntry } = {};
        const listenersOfTypeExist = (type: string): boolean =>
          !!Object.values(listeners).find((listenerObj) => listenerObj.type === type);

        Object.assign(contextApi[classKey], {
          addListener(type: string, callback: IpcEventListener): string {
            const id = randomId();

            // Deduplicate events
            if (!listenersOfTypeExist(type)) {
              ipcRenderer.send(`event-add-${classKey}`, type);
            }

            const eventHandler = (_event: IpcRendererEvent, ...args: IpcSerializable[]): void => callback(...args);

            ipcRenderer.addListener(`event-${classKey}-${type}`, eventHandler);
            listeners[id] = { type, listener: eventHandler };

            return id;
          },
          removeListener(id: string): void {
            if (!listeners[id]) {
              throw new Error('Invalid id');
            }

            const { type, listener } = listeners[id];

            ipcRenderer.removeListener(`event-${classKey}-${type}`, listener);

            delete listeners[id];

            if (!listenersOfTypeExist(type)) {
              ipcRenderer.send(`event-remove-${classKey}-${type}`);
            }
          },
          removeAllListeners(type: string): void {
            Object.entries(listeners).forEach(([id, listenerObj]) => {
              if (!type || listenerObj.type === type) {
                ipcRenderer.removeListener(`event-${classKey}-${listenerObj.type}`, listenerObj.listener);
                ipcRenderer.send(`event-remove-${classKey}-${listenerObj.type}`);
                delete listeners[id];
              }
            });
          },
        });
      }
    });
});

contextBridge.exposeInMainWorld('CapacitorCustomPlatform', {
  name: 'electron',
  plugins: contextApi,
});
////////////////////////////////////////////////////////
