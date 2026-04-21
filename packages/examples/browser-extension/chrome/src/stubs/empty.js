// Empty stub for Node.js-only packages
export default {};

// @vercel/oidc stubs
export const getVercelOidcToken = () => Promise.resolve(null);
export const getVercelOidcTokenSync = () => null;
export const getContext = () => ({});

// dotenv stubs
export const config = () => ({ parsed: {} });
export const parse = () => ({});
export const populate = () => {};
export const decrypt = () => "";
