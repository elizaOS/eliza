(() => {
  function T(w, _) {
    const b = w.map((Y) => `"${Y}"`).join(", ");
    return Error(
      `This RPC instance cannot ${_} because the transport did not provide one or more of these methods: ${b}`,
    );
  }
  function y(w = {}) {
    let _ = {},
      b = {},
      Y = void 0;
    function A(G) {
      if (b.unregisterHandler) b.unregisterHandler();
      (b = G), b.registerHandler?.(o);
    }
    function B(G) {
      if (typeof G === "function") {
        Y = G;
        return;
      }
      Y = (W, S) => {
        const J = G[W];
        if (J) return J(S);
        const Q = G._;
        if (!Q)
          throw Error(`The requested method has no handler: ${String(W)}`);
        return Q(W, S);
      };
    }
    const { maxRequestTime: I = 1000 } = w;
    if (w.transport) A(w.transport);
    if (w.requestHandler) B(w.requestHandler);
    if (w._debugHooks) _ = w._debugHooks;
    let K = 0;
    function f() {
      if (K <= 10000000000) return ++K;
      return (K = 0);
    }
    const Z = new Map(),
      $ = new Map();
    function z(G, ...W) {
      const S = W[0];
      return new Promise((J, Q) => {
        if (!b.send) throw T(["send"], "make requests");
        const F = f(),
          O = { type: "request", id: F, method: G, params: S };
        if ((Z.set(F, { resolve: J, reject: Q }), I !== 1 / 0))
          $.set(
            F,
            setTimeout(() => {
              $.delete(F), Z.delete(F), Q(Error("RPC request timed out."));
            }, I),
          );
        _.onSend?.(O), b.send(O);
      });
    }
    const H = new Proxy(z, {
        get: (G, W, S) => {
          if (W in G) return Reflect.get(G, W, S);
          return (J) => z(W, J);
        },
      }),
      j = H;
    function D(G, ...W) {
      const S = W[0];
      if (!b.send) throw T(["send"], "send messages");
      const J = { type: "message", id: G, payload: S };
      _.onSend?.(J), b.send(J);
    }
    const R = new Proxy(D, {
        get: (G, W, S) => {
          if (W in G) return Reflect.get(G, W, S);
          return (J) => D(W, J);
        },
      }),
      L = R,
      V = new Map(),
      P = new Set();
    function p(G, W) {
      if (!b.registerHandler)
        throw T(["registerHandler"], "register message listeners");
      if (G === "*") {
        P.add(W);
        return;
      }
      if (!V.has(G)) V.set(G, new Set());
      V.get(G).add(W);
    }
    function m(G, W) {
      if (G === "*") {
        P.delete(W);
        return;
      }
      if ((V.get(G)?.delete(W), V.get(G)?.size === 0)) V.delete(G);
    }
    async function o(G) {
      if ((_.onReceive?.(G), !("type" in G)))
        throw Error("Message does not contain a type.");
      if (G.type === "request") {
        if (!b.send || !Y)
          throw T(["send", "requestHandler"], "handle requests");
        let { id: W, method: S, params: J } = G,
          Q;
        try {
          Q = { type: "response", id: W, success: !0, payload: await Y(S, J) };
        } catch (F) {
          if (!(F instanceof Error)) throw F;
          Q = { type: "response", id: W, success: !1, error: F.message };
        }
        _.onSend?.(Q), b.send(Q);
        return;
      }
      if (G.type === "response") {
        const W = $.get(G.id);
        if (W != null) clearTimeout(W);
        $.delete(G.id);
        const { resolve: S, reject: J } = Z.get(G.id) ?? {};
        if ((Z.delete(G.id), !G.success)) J?.(Error(G.error));
        else S?.(G.payload);
        return;
      }
      if (G.type === "message") {
        for (const S of P) S(G.id, G.payload);
        const W = V.get(G.id);
        if (!W) return;
        for (const S of W) S(G.payload);
        return;
      }
      throw Error(`Unexpected RPC message type: ${G.type}`);
    }
    return {
      setTransport: A,
      setRequestHandler: B,
      request: H,
      requestProxy: j,
      send: R,
      sendProxy: L,
      addMessageListener: p,
      removeMessageListener: m,
      proxy: { send: L, request: j },
    };
  }
  function N(w, _) {
    const b = {
        maxRequestTime: _.maxRequestTime,
        requestHandler: { ..._.handlers.requests, ..._.extraRequestHandlers },
        transport: { registerHandler: () => {} },
      },
      Y = y(b),
      A = _.handlers.messages;
    if (A)
      Y.addMessageListener("*", (B, I) => {
        const K = A["*"];
        if (K) K(B, I);
        const f = A[B];
        if (f) f(I);
      });
    return Y;
  }
  var { __electrobunWebviewId: q, __electrobunRpcSocketPort: h } = window;
  class x {
    bunSocket;
    rpc;
    rpcHandler;
    constructor(w) {
      (this.rpc = w.rpc), this.init();
    }
    init() {
      if (
        (this.initSocketToBun(),
        (window.__electrobun.receiveMessageFromBun =
          this.receiveMessageFromBun.bind(this)),
        this.rpc)
      )
        this.rpc.setTransport(this.createTransport());
    }
    initSocketToBun() {
      if (!h || !q) return;
      const w = new WebSocket(`ws://localhost:${h}/socket?webviewId=${q}`);
      (this.bunSocket = w),
        w.addEventListener("open", () => {}),
        w.addEventListener("message", async (_) => {
          const b = _.data;
          if (typeof b === "string")
            try {
              const Y = JSON.parse(b),
                A = await window.__electrobun_decrypt(
                  Y.encryptedData,
                  Y.iv,
                  Y.tag,
                );
              this.rpcHandler?.(JSON.parse(A));
            } catch (Y) {
              console.error("Error parsing bun message:", Y);
            }
          else if (b instanceof Blob);
          else console.error("UNKNOWN DATA TYPE RECEIVED:", _.data);
        }),
        w.addEventListener("error", (_) => {
          console.error("Socket error:", _);
        }),
        w.addEventListener("close", (_) => {});
    }
    createTransport() {
      const w = this;
      return {
        send(_) {
          try {
            const b = JSON.stringify(_);
            w.bunBridge(b);
          } catch (b) {
            console.error("bun: failed to serialize message to webview", b);
          }
        },
        registerHandler(_) {
          w.rpcHandler = _;
        },
      };
    }
    async bunBridge(w) {
      if (this.bunSocket?.readyState === WebSocket.OPEN)
        try {
          const {
              encryptedData: _,
              iv: b,
              tag: Y,
            } = await window.__electrobun_encrypt(w),
            B = JSON.stringify({ encryptedData: _, iv: b, tag: Y });
          this.bunSocket.send(B);
          return;
        } catch (_) {
          console.error("Error sending message to bun via socket:", _);
        }
      window.__electrobunBunBridge?.postMessage(w);
    }
    receiveMessageFromBun(w) {
      if (this.rpcHandler) this.rpcHandler(w);
    }
    static defineRPC(w) {
      return N("webview", {
        ...w,
        extraRequestHandlers: {
          evaluateJavascriptWithResponse: ({ script: _ }) => {
            return new Promise((b) => {
              try {
                const A = Function(_)();
                if (A instanceof Promise)
                  A.then((B) => {
                    b(B);
                  }).catch((B) => {
                    console.error("bun: async script execution failed", B),
                      b(String(B));
                  });
                else b(A);
              } catch (Y) {
                console.error("bun: failed to eval script", Y), b(String(Y));
              }
            });
          },
        },
      });
    }
  }
  function C(w) {
    return w >= 500 ? "error" : "warn";
  }
  var n = {
    evaluate: async (w) => ({
      ok: !1,
      error: `BrowserWorkspaceView is not mounted — cannot evaluate tab ${w}`,
    }),
    getTabRect: async () => null,
  };
  function U() {
    if (typeof window > "u") return n;
    return window.__ELIZA_BROWSER_TABS_REGISTRY__ ?? n;
  }
  var l = Symbol.for("elizaos.app.boot-config"),
    u = l;
  function v(w, _) {
    const Y = {
      ...(w.__ELIZAOS_APP_BOOT_CONFIG__ ??
        w.__ELIZA_APP_BOOT_CONFIG__ ??
        w[u]?.current ??
        {}),
      ..._,
    };
    return (
      (w.__ELIZAOS_APP_BOOT_CONFIG__ = Y),
      (w.__ELIZA_APP_BOOT_CONFIG__ = Y),
      (w[u] = { current: Y }),
      Y
    );
  }
  function c() {
    if (typeof window.__electrobun > "u")
      window.__electrobun = {
        receiveMessageFromBun: (w) => {},
        receiveInternalMessageFromBun: (w) => {},
      };
  }
  var X = {},
    d = "__ELIZA_ELECTROBUN_LOG_MIRROR__";
  function i(w) {
    if (!w || typeof w !== "object")
      throw Error("Electrobun RPC params must be an object");
    return w;
  }
  function k(w, _) {
    const b = w[_];
    if (typeof b !== "string")
      throw Error(`Electrobun RPC param "${_}" must be a string`);
    return b;
  }
  function g(w, _) {
    const b = w[_];
    if (typeof b !== "number" || !Number.isFinite(b))
      throw Error(`Electrobun RPC param "${_}" must be a finite number`);
    return b;
  }
  c();
  function t(w, _) {
    if (w === "apiBaseUpdate") {
      const Y = _;
      if (
        ((window.__ELIZA_API_BASE__ = Y.base),
        typeof Y.externalApiBase === "string" && Y.externalApiBase.trim())
      )
        window.__ELIZA_DESKTOP_EXTERNAL_API_BASE__ = Y.externalApiBase.trim();
      else
        Reflect.deleteProperty(window, "__ELIZA_DESKTOP_EXTERNAL_API_BASE__");
      if (Y.token)
        Object.defineProperty(window, "__ELIZA_API_TOKEN__", {
          value: Y.token,
          configurable: !0,
          writable: !0,
          enumerable: !1,
        });
      v(window, { apiBase: Y.base, ...(Y.token ? { apiToken: Y.token } : {}) });
    }
    const b = X[w];
    if (!b) return;
    for (const Y of Array.from(b))
      try {
        Y(_);
      } catch (A) {
        console.error(`[ElectrobunBridge] Listener error for ${w}:`, A);
      }
  }
  function r(w, _) {
    if (typeof w === "string") t(w, _);
  }
  var E = x.defineRPC({
    maxRequestTime: 600000,
    handlers: {
      requests: {
        browserWorkspaceRendererEvaluate: async (w) => {
          const _ = i(w),
            b = k(_, "id"),
            Y = k(_, "script"),
            A = g(_, "timeoutMs");
          return await U().evaluate(b, Y, A);
        },
        browserWorkspaceRendererGetTabRect: async (w) => {
          const _ = i(w);
          return U().getTabRect(k(_, "id"));
        },
      },
      messages: { "*": r },
    },
  });
  new x({ rpc: E });
  function M(w) {
    if (w instanceof Error)
      return { name: w.name, message: w.message, stack: w.stack };
    return w;
  }
  var a = new Proxy(E.request, {
      get(w, _, b) {
        const Y = Reflect.get(w, _, b);
        if (typeof Y !== "function") return Y;
        return async (A) => {
          try {
            return await Y.call(w, A);
          } catch (B) {
            throw (
              (E.request
                .rendererReportDiagnostic({
                  level: "error",
                  source: "rpc",
                  message: `Electrobun RPC request failed: ${String(_)}`,
                  details: M(B),
                })
                .catch(() => {}),
              B)
            );
          }
        };
      },
    }),
    s = {
      request: a,
      onMessage: (w, _) => {
        if (!X[w]) X[w] = new Set();
        X[w].add(_);
      },
      offMessage: (w, _) => {
        if ((X[w]?.delete(_), X[w]?.size === 0)) delete X[w];
      },
    };
  window.__ELIZA_ELECTROBUN_RPC__ = s;
  function e() {
    const w = window;
    if (w[d]) return;
    w[d] = !0;
    const _ = (Y, A, B, I) => {
        E.request
          .rendererReportDiagnostic({
            level: Y,
            source: A,
            message: B,
            details: I,
          })
          .catch(() => {});
      },
      b = ["log", "info", "warn", "error"];
    for (const Y of b) {
      const A = console[Y].bind(console);
      console[Y] = (...B) => {
        A(...B),
          _(
            Y,
            "console",
            B.map((I) => {
              if (typeof I === "string") return I;
              try {
                return JSON.stringify(I);
              } catch {
                return String(I);
              }
            }).join(" "),
          );
      };
    }
    if (
      (window.addEventListener(
        "error",
        (Y) => {
          const A = Y.target;
          if (A && (A.src || A.href)) {
            _("error", "resource", "Failed to load resource", {
              tagName: A.tagName,
              src: A.src,
              href: A.href,
            });
            return;
          }
          _("error", "window.onerror", Y.message || "Unhandled window error", {
            filename: Y.filename,
            lineno: Y.lineno,
            colno: Y.colno,
          });
        },
        !0,
      ),
      window.addEventListener("unhandledrejection", (Y) => {
        _(
          "error",
          "unhandledrejection",
          "Unhandled promise rejection",
          M(Y.reason),
        );
      }),
      typeof window.fetch === "function")
    ) {
      const Y = window.fetch.bind(window);
      window.fetch = async (...A) => {
        const B = Date.now(),
          I = A[0],
          K = A[1],
          f =
            typeof I === "string"
              ? I
              : I instanceof Request
                ? I.url
                : String(I),
          Z = K?.method ?? (I instanceof Request ? I.method : void 0) ?? "GET";
        try {
          const $ = await Y(...A),
            z = $.ok ? null : C($.status);
          if (z)
            _(z, "fetch", `HTTP ${$.status} ${$.statusText}`, {
              url: f,
              method: Z,
              durationMs: Date.now() - B,
            });
          return $;
        } catch ($) {
          throw (
            (_("error", "fetch", "Fetch failed", {
              url: f,
              method: Z,
              durationMs: Date.now() - B,
              error: M($),
            }),
            $)
          );
        }
      };
    }
    if (typeof XMLHttpRequest < "u") {
      const Y = XMLHttpRequest.prototype.open,
        A = XMLHttpRequest.prototype.send;
      (XMLHttpRequest.prototype.open = function (B, I, ...K) {
        return (
          (this.__elizaDiag = {
            method: B,
            url: String(I),
            startedAt: Date.now(),
          }),
          Y.call(this, B, I, ...K)
        );
      }),
        (XMLHttpRequest.prototype.send = function (...B) {
          const K = () => {
              const Z = this.__elizaDiag;
              if (!Z) return;
              const $ = this.status >= 400 ? C(this.status) : null;
              if ($)
                _($, "xhr", `HTTP ${this.status}`, {
                  url: Z.url,
                  method: Z.method,
                  durationMs: Date.now() - Z.startedAt,
                });
            },
            f = () => {
              const Z = this.__elizaDiag;
              _("error", "xhr", "XMLHttpRequest failed", {
                url: Z?.url,
                method: Z?.method,
                durationMs: Z ? Date.now() - Z.startedAt : void 0,
              });
            };
          return (
            this.addEventListener("loadend", K, { once: !0 }),
            this.addEventListener("error", f, { once: !0 }),
            A.call(this, ...B)
          );
        });
    }
  }
  e();
})();
