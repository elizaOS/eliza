declare module "electrobun/bun" {
  type EventListener = (...args: unknown[]) => void;

  const Electrobun: {
    events: {
      on(event: string, listener: EventListener): void;
    };
  };

  export class BrowserWindow {
    constructor(options: {
      title?: string;
      url: string;
      preload?: string;
      frame?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    });
  }

  export default Electrobun;
}
