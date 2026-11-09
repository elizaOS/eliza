(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ValhallaConnect = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Wallet extensions inject into https pages, not chrome-extension pages.
  // Point CONNECT_PAGE_URL at CONNECT_PAGE_URL_LATER when that certificate is live.
  const CONNECT_PAGE_URL = "https://tokenjunction.github.io/eliza-valhalla/connect/";
  const CONNECT_PAGE_URL_LATER = "https://valhalla-app.xyz/connect/";
  const CONNECT_ORIGINS = [
    "https://tokenjunction.github.io",
    "https://valhalla-app.xyz",
    "https://www.valhalla-app.xyz",
  ];
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function decodeBase58(value) {
    if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
    const result = [0];
    for (const char of value) {
      const digit = ALPHABET.indexOf(char);
      if (digit < 0) return null;
      let carry = digit;
      for (let i = 0; i < result.length; i += 1) {
        carry += result[i] * 58;
        result[i] = carry % 256;
        carry = Math.floor(carry / 256);
      }
      while (carry > 0) {
        result.push(carry % 256);
        carry = Math.floor(carry / 256);
      }
    }
    let zeros = 0;
    for (const char of value) {
      if (char !== "1") break;
      zeros += 1;
    }
    const out = new Uint8Array(zeros + result.length);
    for (let i = 0; i < result.length; i += 1) out[out.length - 1 - i] = result[i];
    return out;
  }

  function isPubkey(value) {
    const raw = decodeBase58(value);
    return Boolean(raw && raw.length === 32);
  }

  function buildSiwsMessage(input) {
    return (
      `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n` +
      "Sign in to Valhalla. Read-only. This is not a transaction.\n\n" +
      `Nonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expiresAt}`
    );
  }

  function bytesOf(signature) {
    if (!signature || typeof signature.length !== "number") return null;
    return signature instanceof Uint8Array ? signature : Uint8Array.from(signature);
  }

  function verifySiws(nacl, proof) {
    const key = decodeBase58(proof.publicKey || proof.address);
    const sig = bytesOf(proof.signature);
    const message = String(proof.message || "");
    if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
    if (!message.includes("Sign in to Valhalla")) return false;
    if (!message.includes("This is not a transaction.")) return false;
    if (!message.includes(String(proof.publicKey || proof.address))) return false;
    const exp = /Expiration Time: (.+)/.exec(message);
    if (!exp || Number.isNaN(Date.parse(exp[1])) || Date.parse(exp[1]) < Date.now()) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, key);
  }

  async function adapterFromStandard(wallet) {
    const connect = wallet.features && wallet.features["standard:connect"] && wallet.features["standard:connect"].connect;
    const sign = wallet.features && wallet.features["solana:signMessage"] && wallet.features["solana:signMessage"].signMessage;
    if (typeof connect !== "function" || typeof sign !== "function") return null;
    const result = await connect();
    const accounts = (result && result.accounts) || wallet.accounts || [];
    const account = accounts[0];
    if (!account || !isPubkey(account.address)) return null;
    return {
      name: wallet.name || "",
      address: account.address,
      signMessage: async (bytes) => {
        const signed = await sign([{ account, message: bytes }]);
        const row = Array.isArray(signed) ? signed[0] : signed;
        return row && row.signature;
      },
    };
  }

  async function adapterFromInjected(provider, fallbackName) {
    if (!provider || typeof provider.connect !== "function" || typeof provider.signMessage !== "function") return null;
    const connected = await provider.connect();
    const key = (connected && connected.publicKey) || provider.publicKey;
    const address = key && typeof key.toString === "function" ? key.toString() : "";
    if (!isPubkey(address)) return null;
    return {
      name: provider.name || fallbackName,
      address,
      signMessage: async (bytes) => {
        const signed = await provider.signMessage(bytes, "utf8");
        return signed && (signed.signature || signed);
      },
    };
  }

  function pickNamed(list, which) {
    const pattern = which === "solflare" ? /solflare/i : /phantom/i;
    return (list || []).find((item) => pattern.test(item.name || "")) || null;
  }

  async function signInWithAdapter(adapter, nacl, input) {
    const message = buildSiwsMessage({
      domain: input.domain,
      address: adapter.address,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    const signature = bytesOf(await adapter.signMessage(new TextEncoder().encode(message)));
    const proof = { message, signature, publicKey: adapter.address, address: adapter.address };
    if (!verifySiws(nacl, proof)) throw new Error("The sign-in was not accepted.");
    return {
      address: adapter.address,
      message,
      signature,
      nonce: input.nonce,
      session: { address: adapter.address, nonce: input.nonce, expiresAt: input.expiresAt },
    };
  }

  function connectPage(which, extensionId) {
    const url = new URL(CONNECT_PAGE_URL);
    if (which) url.searchParams.set("wallet", which);
    if (extensionId) url.searchParams.set("ext", extensionId);
    return url.toString();
  }

  function allowedOrigin(origin) {
    return CONNECT_ORIGINS.includes(String(origin || ""));
  }

  function originOf(pageUrl) {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return "";
    }
  }

  function walletChoices() {
    return [
      {
        id: "phantom",
        label: "Continue with Phantom",
        install: "https://phantom.com/download",
        browse(pageUrl) {
          return `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(originOf(pageUrl))}`;
        },
      },
      {
        id: "solflare",
        label: "Continue with Solflare",
        install: "https://solflare.com/download",
        browse(pageUrl) {
          return `https://solflare.com/ul/v1/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(originOf(pageUrl))}`;
        },
      },
      {
        id: "backpack",
        label: "Continue with Backpack",
        install: "https://backpack.app/download",
        browse(pageUrl) {
          return `https://backpack.app/ul/v1/browse/${encodeURIComponent(pageUrl)}`;
        },
      },
      { id: "other", label: "Other wallet", install: "", browse: null },
    ];
  }

  function walletStep(id, options) {
    const choice = walletChoices().find((item) => item.id === id) || walletChoices()[3];
    if (options.installed) return { action: "connect", id: choice.id };
    if (options.mobile && choice.browse) return { action: "browse", url: choice.browse(options.pageUrl) };
    if (choice.install) return { action: "install", url: choice.install };
    return { action: "none", id: choice.id };
  }

  function handoff(proof, signatureB64) {
    return {
      source: "valhalla-connect",
      type: "siws",
      pubkey: proof.address,
      signature: signatureB64,
      message: proof.message,
    };
  }

  return {
    CONNECT_PAGE_URL,
    CONNECT_PAGE_URL_LATER,
    CONNECT_ORIGINS,
    decodeBase58,
    isPubkey,
    buildSiwsMessage,
    verifySiws,
    adapterFromStandard,
    adapterFromInjected,
    pickNamed,
    signInWithAdapter,
    connectPage,
    allowedOrigin,
    handoff,
    walletChoices,
    walletStep,
  };
});
