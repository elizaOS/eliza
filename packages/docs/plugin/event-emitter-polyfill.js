// plugins/event-emitter-polyfill.js

// Polyfill global EventEmitter for server-side if it's not defined.
if (typeof global.EventEmitter === "undefined") {
	global.EventEmitter = require("node:events").EventEmitter;
}

module.exports = () => ({
	name: "event-emitter-polyfill",
	configureWebpack(_config, isServer) {
		if (!isServer) {
			return {
				resolve: {
					fallback: {
						// For client-side, map Node's "events" module to the polyfilled version.
						events: require.resolve("events/"),
					},
				},
			};
		}
		return {};
	},
});
