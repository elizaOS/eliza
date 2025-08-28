// Re-export per-target Sentry façade. The bundler picks the right file via entrypoints.
export { Sentry } from './instrument.node';