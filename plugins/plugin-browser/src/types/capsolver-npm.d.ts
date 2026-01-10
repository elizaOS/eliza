declare module 'capsolver-npm' {
  interface CaptchaSolverOptions {
    websiteURL: string;
    websiteKey: string;
  }

  interface CaptchaSolution {
    gRecaptchaResponse: string;
  }

  export default class CaptchaSolver {
    constructor(apiKey: string);
    hcaptchaProxyless(options: CaptchaSolverOptions): Promise<CaptchaSolution>;
    recaptchaV2Proxyless(options: CaptchaSolverOptions): Promise<CaptchaSolution>;
  }
}
