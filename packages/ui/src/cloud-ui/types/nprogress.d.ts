declare module "nprogress" {
  interface NProgressOptions {
    easing: string;
    minimum: number;
    showSpinner: boolean;
    speed: number;
    trickle: boolean;
    trickleSpeed: number;
  }

  interface NProgress {
    configure(options: Partial<NProgressOptions>): NProgress;
    done(force?: boolean): NProgress;
    start(): NProgress;
  }

  const nprogress: NProgress;
  export default nprogress;
}
