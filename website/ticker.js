(function () {
  var MAX_TOKENS = 10;
  var SOL_ADDRESS = "So11111111111111111111111111111111111111112";

  function node(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    item.textContent = text;
    return item;
  }

  function price(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: number < 1 ? 4 : 2,
      maximumFractionDigits: number < 0.0001 ? 10 : number < 1 ? 8 : 2
    }).format(number);
  }

  function change(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return (number > 0 ? "+" : "") + number.toFixed(1) + "%";
  }

  function marketUrl(address) {
    var value = String(address || "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return "";
    return "https://dexscreener.com/solana/" + encodeURIComponent(value);
  }

  function appendQuote(parent, label, value, move, badge, address) {
    var number = Number(move);
    var href = marketUrl(address);
    var quote = node(href ? "a" : "span", "ticker-quote " + (Number.isFinite(number) && number < 0 ? "dn" : "up"), "");
    if (href) {
      quote.href = href;
      quote.target = "_blank";
      quote.rel = "noopener noreferrer";
      quote.setAttribute("aria-label", label + " price $" + price(value) + ", 24 hour change " + change(move) + ". Opens DexScreener in a new tab.");
    }
    quote.appendChild(node("strong", "", label));
    quote.appendChild(document.createTextNode(" $" + price(value) + " " + change(move)));
    if (badge) quote.appendChild(node("em", "badge mode", badge));
    parent.appendChild(quote);
  }

  function paint(bar, data) {
    var items = document.createElement("div");
    var sol = data.sol || {};
    if (Number(sol.usd) > 0) appendQuote(items, "SOL", sol.usd, sol.change24h, "", SOL_ADDRESS);
    (data.tokens || []).slice(0, MAX_TOKENS).forEach(function (token) {
      var symbol = String(token.symbol || "TOKEN").slice(0, 12);
      appendQuote(items, symbol, token.price, token.change24h, String(token.badge || ""), token.address || token.tokenAddress);
    });
    var labels = [];
    if (Number(sol.usd) > 0) labels.push("SOL");
    if ((data.tokens || []).length) labels.push("DexScreener");
    items.appendChild(node("span", "ticker-source",
      "Live · " + (labels.join(" + ") || "public market data") + " · select a quote for its chart · not financial advice"));

    var line = document.createElement("div");
    line.className = "ticker-track";
    Array.prototype.slice.call(items.childNodes).forEach(function (item, index) {
      if (index) line.appendChild(document.createTextNode(" · "));
      line.appendChild(item);
    });
    line.appendChild(document.createTextNode(" · "));
    var duplicate = line.cloneNode(true);
    duplicate.setAttribute("aria-hidden", "true");
    duplicate.inert = true;
    Array.prototype.forEach.call(duplicate.querySelectorAll("a"), function (link) {
      link.tabIndex = -1;
    });
    line.appendChild(duplicate);

    bar.textContent = "";
    bar.appendChild(line);
    bar.hidden = false;
    bar.classList.remove("ticker-unavailable");
    bar.setAttribute("aria-label", "Live public prices. Not financial advice.");
    bar.dataset.updatedAt = String(Number(data.at) || Date.now());
    bar.classList.remove("ticker-paused");
  }

  async function getJson(url, signal) {
    var response = await fetch(url, { cache: "no-store", signal: signal });
    if (!response.ok) throw new Error("market data " + response.status);
    return response.json();
  }

  async function directData(signal) {
    var tasks = await Promise.allSettled([
      getJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true", signal),
      getJson("https://api.dexscreener.com/token-boosts/top/v1", signal)
    ]);

    var sol = null;
    if (tasks[0].status === "fulfilled") {
      var solRow = tasks[0].value && tasks[0].value.solana;
      var usd = Number(solRow && solRow.usd);
      if (Number.isFinite(usd) && usd > 0) {
        sol = { usd: usd, change24h: Number(solRow.usd_24h_change) || 0 };
      }
    }

    var rows = tasks[1].status === "fulfilled" && Array.isArray(tasks[1].value) ? tasks[1].value : [];
    var addresses = [];
    var seen = Object.create(null);
    rows.forEach(function (row) {
      var address = row && row.chainId === "solana" ? String(row.tokenAddress || "") : "";
      if (!address || seen[address]) return;
      seen[address] = true;
      addresses.push(address);
    });
    addresses = addresses.slice(0, MAX_TOKENS);

    var tokens = [];
    if (addresses.length) {
      var pairsBody = await getJson(
        "https://api.dexscreener.com/latest/dex/tokens/" + addresses.map(encodeURIComponent).join(","),
        signal
      );
      var addressSet = Object.create(null);
      addresses.forEach(function (address) { addressSet[address] = true; });
      var bestByAddress = Object.create(null);
      (pairsBody.pairs || []).forEach(function (pair) {
        var address = String(pair && pair.baseToken && pair.baseToken.address || "");
        var priceUsd = Number(pair && pair.priceUsd);
        if (!pair || pair.chainId !== "solana" || !addressSet[address] ||
            !Number.isFinite(priceUsd) || priceUsd <= 0) return;
        var liquidity = Number(pair.liquidity && pair.liquidity.usd) || 0;
        if (!bestByAddress[address] || liquidity > bestByAddress[address].liquidity) {
          bestByAddress[address] = { pair: pair, liquidity: liquidity };
        }
      });
      addresses.forEach(function (address) {
        var selected = bestByAddress[address];
        if (!selected) return;
        var pair = selected.pair;
        tokens.push({
          symbol: String(pair.baseToken.symbol || "TOKEN").slice(0, 12),
          price: Number(pair.priceUsd),
          change24h: Number(pair.priceChange && pair.priceChange.h24) || 0,
          badge: selected.liquidity >= 20000 ? "Liq" : "Thin",
          address: address
        });
      });
    }

    if (!sol && !tokens.length) throw new Error("all public price sources unavailable");
    return {
      sol: sol,
      tokens: tokens,
      sources: (sol ? "CoinGecko" : "") + (tokens.length ? (sol ? ", " : "") + "DexScreener" : ""),
      at: Date.now()
    };
  }

  function unavailable(bar, text) {
    bar.textContent = "";
    bar.appendChild(node("span", "ticker-status", text));
    bar.hidden = false;
    bar.classList.add("ticker-unavailable");
    bar.setAttribute("aria-label", text);
  }

  async function pull() {
    var bars = Array.prototype.slice.call(document.querySelectorAll("[data-ticker]"));
    var url = String((window.VALHALLA_SITE || {}).TICKER_URL || "");
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeout = controller ? window.setTimeout(function () { controller.abort(); }, 12000) : 0;
    try {
      var data;
      if (url) {
        try {
          data = await getJson(url, controller ? controller.signal : undefined);
        } catch (workerError) {
          console.debug("valhalla", "V-TICK", "aggregator unavailable; using public sources");
          if (controller && controller.signal.aborted) {
            window.clearTimeout(timeout);
            controller = new AbortController();
            timeout = window.setTimeout(function () { controller.abort(); }, 12000);
          }
          data = await directData(controller ? controller.signal : undefined);
        }
      } else {
        data = await directData(controller ? controller.signal : undefined);
      }
      if (!data || !data.sol || !Number.isFinite(Number(data.sol.usd)) || Number(data.sol.usd) <= 0) {
        if (!data || !(data.tokens || []).length) throw new Error("price data unavailable");
      }
      window.ValhallaTicker.last = data;
      bars.forEach(function (bar) { paint(bar, data); });
    } catch (err) {
      console.debug("valhalla", "V-TICK", String(err && err.message || err));
      bars.forEach(function (bar) {
        if (window.ValhallaTicker.last) {
          var updated = Number(window.ValhallaTicker.last.at) || 0;
          unavailable(bar, "PRICE FEED · STALE · last successful update " +
            (updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) + "s ago" : "unknown"));
        } else {
          unavailable(bar, "PRICE FEED · UNAVAILABLE · could not reach market data service");
        }
      });
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  }

  window.ValhallaTicker = { last: null };
  var directInterval = 60000;
  function boot() {
    pull();
    var url = String((window.VALHALLA_SITE || {}).TICKER_URL || "");
    window.setInterval(pull, url ? 20000 : directInterval);
    var bars = document.querySelectorAll("[data-ticker]");
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          entry.target.classList.toggle("ticker-paused", !entry.isIntersecting || document.hidden);
        });
      });
      Array.prototype.forEach.call(bars, function (bar) { observer.observe(bar); });
    }
    document.addEventListener("visibilitychange", function () {
      Array.prototype.forEach.call(bars, function (bar) {
        if (document.hidden) bar.classList.add("ticker-paused");
        else if (!("IntersectionObserver" in window)) bar.classList.remove("ticker-paused");
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
