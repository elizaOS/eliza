(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function spark(canvas, values, color) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.clientWidth * 2;
    const h = canvas.height = 144;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = (index / (values.length - 1 || 1)) * (w - 8) + 4;
      const y = h - 8 - ((value - min) / span) * (h - 16);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function candles(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.clientWidth * 2;
    const h = canvas.height = 144;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 18; i += 1) {
      const x = 12 + i * ((w - 24) / 18);
      const open = 40 + ((i * 17) % 50);
      const close = open + ((i % 3) - 1) * 18;
      ctx.strokeStyle = close >= open ? "#69ffc0" : "#ff5a6a";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(x, Math.min(open, close), 8, Math.max(6, Math.abs(close - open)));
    }
  }

  function gauge(canvas, score) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width = 280;
    const h = canvas.height = 160;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#2c281f";
    ctx.beginPath();
    ctx.arc(140, 120, 80, Math.PI, 0);
    ctx.stroke();
    ctx.strokeStyle = "#ffb347";
    ctx.beginPath();
    ctx.arc(140, 120, 80, Math.PI, Math.PI + Math.PI * (Math.max(0, Math.min(100, score)) / 100));
    ctx.stroke();
    ctx.fillStyle = "#f4ecdf";
    ctx.font = "700 28px ui-sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(score), 140, 110);
  }

  function mountCharts() {
    const equity = document.getElementById("equity");
    if (equity && !document.getElementById("spark")) {
      const canvas = document.createElement("canvas");
      canvas.id = "spark";
      canvas.className = "spark";
      equity.parentElement.appendChild(canvas);
      const series = [12, 14, 13, 18, 17, 21, 19, 24];
      spark(canvas, series, "#ffb347");
      if (!reduce) {
        let tick = 0;
        setInterval(() => {
          series.push(series[series.length - 1] + Math.sin(tick) * 2);
          series.shift();
          spark(canvas, series, "#ffb347");
          tick += 1;
        }, 2000);
      }
    }
    const signal = document.getElementById("signalOut");
    if (signal && !document.getElementById("gauge")) {
      const canvas = document.createElement("canvas");
      canvas.id = "gauge";
      canvas.className = "gauge";
      signal.before(canvas);
      gauge(canvas, 64);
    }
    const brain = document.getElementById("brainPanel");
    if (brain && !document.getElementById("candles")) {
      const canvas = document.createElement("canvas");
      canvas.id = "candles";
      canvas.className = "spark";
      brain.before(canvas);
      candles(canvas);
    }
  }

  function mountTalk() {
    if (document.getElementById("talk")) return;
    const node = document.createElement("section");
    node.id = "talk";
    node.innerHTML = '<header><span>V</span> TALK TO VALHALLA</header><div id="talkLog"></div><form id="talkForm"><input id="talkInput" placeholder="Ask about status" autocomplete="off"><button type="button" id="talkVoice">Voice</button><button type="submit">Send</button></form>';
    document.body.appendChild(node);
    const log = node.querySelector("#talkLog");
    function add(text, mine) {
      const card = document.createElement("div");
      card.className = mine ? "bubble me" : "bubble";
      card.textContent = text;
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
      return card;
    }
    node.querySelector("#talkForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = node.querySelector("#talkInput");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      add(text, true);
      const card = add("…", false);
      try {
        const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
        const body = await response.json();
        const reply = body.message || "I can report status, positions, and P&L.";
        card.textContent = "";
        if (reduce) card.textContent = reply;
        else {
          let i = 0;
          const timer = setInterval(() => {
            card.textContent = reply.slice(0, i);
            i += 2;
            if (i > reply.length) clearInterval(timer);
          }, 16);
        }
      } catch {
        card.textContent = "The desk did not answer. Nothing was sent.";
      }
    });
    node.querySelector("#talkVoice").addEventListener("click", () => {
      const last = log.querySelector(".bubble:last-child");
      if (!last || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(last.textContent));
    });
  }

  mountCharts();
  mountTalk();
})();
