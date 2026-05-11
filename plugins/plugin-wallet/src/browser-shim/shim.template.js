/* eslint-disable */
// biome-ignore-all lint/correctness/noInnerDeclarations: this injected browser template intentionally uses function-scoped var declarations for compatibility.
/**
 * Wallet shim — runs inside an arbitrary dApp page (in MAIN world) and exposes
 * the agent's resident keypairs as both a Solana Wallet-Standard wallet and an
 * EIP-1193 EVM provider. All signing requests proxy back to the agent's local
 * HTTP API (`@elizaos/plugin-wallet` sign endpoints) over fetch.
 *
 * The shim is consumed via `buildWalletShim({ apiBase, signToken, walletName,
 * walletIcon, solanaPublicKey, evmAddress })` which substitutes the placeholder
 * `__SHIM_CONFIG__` token and returns a self-contained string suitable for
 * `Page.addInitScript` / `BROWSER eval` / a MAIN-world content script.
 *
 * This file is the runtime template — keep it dependency-free and ES2017
 * compatible (no `??`, `?.` for older browsers is fine — most dApps run in
 * modern Chrome). It must NOT import anything.
 */
(function installWalletShim() {
  if (window.__elizaWalletShimInstalled) return;
  window.__elizaWalletShimInstalled = true;

  /** @type {{ apiBase: string, signToken: string, walletName: string, walletIcon: string, solanaPublicKey: string|null, evmAddress: string|null, evmChainId: number }} */
  // The comment marker below is the substitution point used by build-shim.ts
  // — keep it unique so the doc-block reference at the top of the file is
  // never accidentally replaced first.
  var CONFIG = /*ELIZA_WALLET_SHIM_CONFIG_INSERT*/ null;

  // ---------- helpers ----------------------------------------------------

  function bytesToBase64(bytes) {
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray
          ? bytes.subarray(i, i + chunk)
          : bytes.slice(i, i + chunk),
      );
    }
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function _bytesToHex(bytes) {
    var out = "0x";
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      out += h.length === 1 ? `0${h}` : h;
    }
    return out;
  }
  function utf8ToBytes(s) {
    return new TextEncoder().encode(s);
  }
  // base58 (Bitcoin alphabet) — small impl, only needed to log the active key
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function _base58Encode(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    var out = "";
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
    for (var m = digits.length - 1; m >= 0; m--) out += B58[digits[m]];
    return out;
  }
  function base58Decode(s) {
    var bytes = [0];
    for (var i = 0; i < s.length; i++) {
      var c = B58.indexOf(s[i]);
      if (c < 0) throw new Error("invalid base58");
      var carry = c;
      for (var j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (var k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  function api(path, body) {
    return fetch(CONFIG.apiBase + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.signToken}`,
      },
      body: JSON.stringify(body || {}),
    }).then((r) => {
      if (!r.ok) {
        return r.text().then((t) => {
          throw new Error(`wallet-shim ${path} ${r.status}: ${t}`);
        });
      }
      return r.json();
    });
  }

  // ---------- emitter ----------------------------------------------------
  function makeEmitter() {
    var listeners = {};
    return {
      on: (e, l) => {
        listeners[e] = listeners[e] || [];
        listeners[e].push(l);
        return () => {
          listeners[e] = (listeners[e] || []).filter((x) => x !== l);
        };
      },
      emit: (e, ...args) => {
        (listeners[e] || []).forEach((l) => {
          try {
            l.apply(null, args);
          } catch (_) {}
        });
      },
    };
  }

  // ---------- Solana Wallet Standard -------------------------------------
  function installSolana() {
    if (!CONFIG.solanaPublicKey) return;
    var publicKey = CONFIG.solanaPublicKey;
    var publicKeyBytes = base58Decode(publicKey);
    var emitter = makeEmitter();

    var account = {
      address: publicKey,
      publicKey: publicKeyBytes,
      chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
      features: [
        "solana:signTransaction",
        "solana:signAndSendTransaction",
        "solana:signMessage",
        "standard:connect",
        "standard:disconnect",
        "standard:events",
      ],
      label: CONFIG.walletName,
    };

    function connect() {
      return Promise.resolve({ accounts: [account] });
    }
    function disconnect() {
      return Promise.resolve();
    }

    function signTransaction(input) {
      var inputs = Array.isArray(input) ? input : [input];
      var b64s = inputs.map((i) => bytesToBase64(i.transaction));
      return api("/wallet/solana/sign-all-transactions", {
        transactionsBase64: b64s,
      }).then((resp) =>
        resp.signedBase64s.map((b64) => ({
          signedTransaction: base64ToBytes(b64),
        })),
      );
    }

    function signAndSendTransaction(input) {
      var inputs = Array.isArray(input) ? input : [input];
      return Promise.all(
        inputs.map((i) =>
          api("/wallet/solana/sign-and-send-transaction", {
            transactionBase64: bytesToBase64(i.transaction),
            sendOptions: i.options || {},
          }).then((resp) => ({ signature: base58Decode(resp.signature) })),
        ),
      );
    }

    function signMessage(input) {
      var inputs = Array.isArray(input) ? input : [input];
      return Promise.all(
        inputs.map((i) =>
          api("/wallet/solana/sign-message", {
            messageBase64: bytesToBase64(i.message),
          }).then((resp) => ({
            signedMessage: i.message,
            signature: base64ToBytes(resp.signatureBase64),
            signatureType: "ed25519",
          })),
        ),
      );
    }

    var wallet = {
      version: "1.0.0",
      name: CONFIG.walletName,
      icon: CONFIG.walletIcon,
      chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
      accounts: [account],
      features: {
        "standard:connect": { version: "1.0.0", connect: connect },
        "standard:disconnect": { version: "1.0.0", disconnect: disconnect },
        "standard:events": {
          version: "1.0.0",
          on: (e, l) => emitter.on(e, l),
        },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: signTransaction,
        },
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signAndSendTransaction: signAndSendTransaction,
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: signMessage,
        },
      },
    };

    // --- Wallet Standard registration --------------------------------
    function registerCallback(api) {
      try {
        api.register(wallet);
      } catch (_e) {
        // already registered or registry refused — non-fatal
      }
    }

    function fireRegister() {
      try {
        var ev = new CustomEvent("wallet-standard:register-wallet", {
          detail: registerCallback,
        });
        window.dispatchEvent(ev);
      } catch (_) {}
    }

    // Apps fire `wallet-standard:app-ready` with detail = api ({ register }).
    try {
      window.addEventListener(
        "wallet-standard:app-ready",
        (e) => {
          if (e?.detail) registerCallback(e.detail);
        },
        false,
      );
    } catch (_) {}

    // We fire register-wallet immediately so app-side listeners see us.
    fireRegister();
    // And again on DOMContentLoaded + load to handle late wallet adapters.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fireRegister, false);
    }
    window.addEventListener("load", fireRegister, false);

    // --- Phantom-compatibility legacy provider ----------------------
    // Many older Solana dApps still detect `window.solana?.isPhantom`.
    var phantomLike = {
      isPhantom: true,
      isConnected: true,
      publicKey: {
        toBase58: () => publicKey,
        toBuffer: () => publicKeyBytes,
        toBytes: () => publicKeyBytes,
        toString: () => publicKey,
      },
      connect: function () {
        return Promise.resolve({ publicKey: this.publicKey });
      },
      disconnect: () => {
        emitter.emit("disconnect");
        return Promise.resolve();
      },
      on: emitter.on,
      off: () => {},
      signTransaction: (tx) => {
        // legacy phantom returns a single signed tx (Transaction object); we
        // only have raw bytes so dApps using the new adapter pattern get the
        // proper Wallet-Standard call instead.
        var serialized =
          typeof tx.serialize === "function"
            ? tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
              })
            : tx;
        return api("/wallet/solana/sign-transaction", {
          transactionBase64: bytesToBase64(new Uint8Array(serialized)),
        }).then((resp) => {
          var bytes = base64ToBytes(resp.signedBase64);
          // Try to populate signatures back into the original tx object so
          // dApp code that does `tx.signatures` keeps working.
          if (tx && Array.isArray(tx.signatures)) {
            // No-op; we return raw bytes the dApp can re-deserialize.
          }
          // Most dApps either re-deserialize or call signAndSend; expose bytes
          // via `serialize()` on the returned object.
          return {
            serialize: () => bytes,
            __signedBytes: bytes,
          };
        });
      },
      signAllTransactions: (txs) => {
        var b64s = txs.map((tx) => {
          var serialized =
            typeof tx.serialize === "function"
              ? tx.serialize({
                  requireAllSignatures: false,
                  verifySignatures: false,
                })
              : tx;
          return bytesToBase64(new Uint8Array(serialized));
        });
        return api("/wallet/solana/sign-all-transactions", {
          transactionsBase64: b64s,
        }).then((resp) =>
          resp.signedBase64s.map((b64) => {
            var bytes = base64ToBytes(b64);
            return {
              serialize: () => bytes,
              __signedBytes: bytes,
            };
          }),
        );
      },
      signMessage: (message, _encoding) =>
        api("/wallet/solana/sign-message", {
          messageBase64: bytesToBase64(
            message instanceof Uint8Array
              ? message
              : utf8ToBytes(String(message)),
          ),
        }).then((resp) => ({
          signature: base64ToBytes(resp.signatureBase64),
          publicKey: { toBase58: () => publicKey },
        })),
      signAndSendTransaction: (tx, options) => {
        var serialized =
          typeof tx.serialize === "function"
            ? tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
              })
            : tx;
        return api("/wallet/solana/sign-and-send-transaction", {
          transactionBase64: bytesToBase64(new Uint8Array(serialized)),
          sendOptions: options || {},
        }).then((resp) => ({ signature: resp.signature }));
      },
    };

    try {
      if (!window.solana) {
        Object.defineProperty(window, "solana", {
          value: phantomLike,
          configurable: true,
          writable: false,
        });
      }
      if (!window.phantom) {
        Object.defineProperty(window, "phantom", {
          value: { solana: phantomLike },
          configurable: true,
          writable: false,
        });
      }
    } catch (_) {}
  }

  // ---------- EIP-1193 / EIP-6963 EVM provider ---------------------------
  function installEvm() {
    if (!CONFIG.evmAddress) return;
    var address = CONFIG.evmAddress.toLowerCase();
    var emitter = makeEmitter();
    var chainId = `0x${CONFIG.evmChainId.toString(16)}`;

    function rpc(method, params) {
      // Forward read-only RPC methods to a public RPC for this chain. The agent
      // only signs; it does not proxy reads. The shim picks the chain-default
      // RPC from the same map the server uses (see below).
      return fetch(CONFIG.evmRpcByChainId[String(parseInt(chainId, 16))], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: method,
          params: params || [],
        }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (j.error) throw new Error(j.error.message || "rpc error");
          return j.result;
        });
    }

    var provider = {
      isMetaMask: true, // many dApps gate connect-button discovery on this
      isElizaWallet: true,
      _state: { isConnected: true, accounts: [address], chainId: chainId },
      request: (args) => {
        var method = args?.method;
        var params = args?.params || [];
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return Promise.resolve([address]);
          case "eth_chainId":
          case "net_version":
            return Promise.resolve(
              method === "net_version"
                ? String(parseInt(chainId, 16))
                : chainId,
            );
          case "wallet_switchEthereumChain":
            try {
              var nextHex = params[0]?.chainId;
              if (typeof nextHex === "string") {
                chainId = nextHex;
                emitter.emit("chainChanged", chainId);
              }
            } catch (_) {}
            return Promise.resolve(null);
          case "wallet_addEthereumChain":
            return Promise.resolve(null);
          case "personal_sign": {
            // params: [message, address] (some dApps reverse the order; tolerate both)
            var msg = params[0];
            var maybeAddr = params[1];
            if (
              typeof maybeAddr === "string" &&
              maybeAddr.toLowerCase() !== address &&
              typeof msg === "string" &&
              msg.toLowerCase() === address
            ) {
              var swap = msg;
              msg = maybeAddr;
              maybeAddr = swap;
            }
            return api("/wallet/evm/personal-sign", { message: msg }).then(
              (r) => r.signature,
            );
          }
          case "eth_sign": {
            return api("/wallet/evm/personal-sign", {
              message: params[1],
            }).then((r) => r.signature);
          }
          case "eth_signTypedData_v4":
          case "eth_signTypedData": {
            var data = params[1];
            if (typeof data === "string") {
              try {
                data = JSON.parse(data);
              } catch (_) {}
            }
            return api("/wallet/evm/sign-typed-data", { typedData: data }).then(
              (r) => r.signature,
            );
          }
          case "eth_sendTransaction": {
            var tx = params[0] || {};
            return api("/wallet/evm/send-transaction", {
              chainId: parseInt(chainId, 16),
              tx: tx,
            }).then((r) => r.hash);
          }
          case "eth_signTransaction": {
            var tx2 = params[0] || {};
            return api("/wallet/evm/sign-transaction", {
              chainId: parseInt(chainId, 16),
              tx: tx2,
            }).then((r) => r.signedTransaction);
          }
          default:
            // forward read-only methods to public RPC
            return rpc(method, params);
        }
      },
      on: (e, l) => {
        emitter.on(e, l);
      },
      removeListener: () => {},
      enable: () => Promise.resolve([address]),
    };

    try {
      if (!window.ethereum) {
        Object.defineProperty(window, "ethereum", {
          value: provider,
          configurable: true,
          writable: false,
        });
      } else if (Array.isArray(window.ethereum.providers)) {
        window.ethereum.providers.push(provider);
      }
    } catch (_) {}

    // EIP-6963 — modern multi-wallet discovery used by RainbowKit, Wagmi, etc.
    var info = {
      uuid:
        "00000000-0000-4000-8000-" +
        `000000000000${Math.floor(Math.random() * 1e12).toString(16)}`.slice(
          -12,
        ),
      name: CONFIG.walletName,
      icon: CONFIG.walletIcon,
      rdns: "ai.elizaos.wallet",
    };
    function announce() {
      try {
        var ev = new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info: info, provider: provider }),
        });
        window.dispatchEvent(ev);
      } catch (_) {}
    }
    try {
      window.addEventListener("eip6963:requestProvider", announce, false);
    } catch (_) {}
    announce();

    // Notify dApps that a connected wallet exists.
    setTimeout(() => {
      emitter.emit("connect", { chainId: chainId });
      emitter.emit("accountsChanged", [address]);
    }, 0);
  }

  installSolana();
  installEvm();
})();
