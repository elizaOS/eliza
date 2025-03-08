/**
 * Simple EventEmitter polyfill for documentation
 */
if (typeof global !== "undefined" && !global.EventEmitter) {
	global.EventEmitter = class EventEmitter {
		constructor() {
			this.events = {};
		}

		on(event, listener) {
			if (!this.events[event]) {
				this.events[event] = [];
			}
			this.events[event].push(listener);
			return this;
		}

		once(event, listener) {
			const onceWrapper = (...args) => {
				listener(...args);
				this.removeListener(event, onceWrapper);
			};
			return this.on(event, onceWrapper);
		}

		emit(event, ...args) {
			if (!this.events[event]) {
				return false;
			}
			this.events[event].forEach((listener) => listener(...args));
			return true;
		}

		removeListener(event, listener) {
			if (!this.events[event]) {
				return this;
			}
			this.events[event] = this.events[event].filter((l) => l !== listener);
			return this;
		}
	};
}

// Also add to window for client-side rendering
if (typeof window !== "undefined" && !window.EventEmitter) {
	window.EventEmitter = global.EventEmitter;
}
