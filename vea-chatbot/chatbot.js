/**
 * Virtually Ever After — Embedded Chatbot Widget
 * No backend, no API key required.
 * Drop one <script> tag onto any page to activate.
 *
 * Usage:
 *   <script src="chatbot.js"></script>
 * Or with options:
 *   <script src="chatbot.js"
 *           data-position="bottom-right"
 *           data-theme="rose"
 *           data-greeting="Hi! Ask me anything about Virtually Ever After ✨">
 *   </script>
 */
(function () {
  "use strict";

  /* ───────────────────────────────────────────
     0. CONFIG  (override via data-* attributes)
  ─────────────────────────────────────────── */
  const scriptEl =
    document.currentScript ||
    document.querySelector('script[src*="chatbot.js"]');

  const CFG = {
    position: (scriptEl && scriptEl.dataset.position) || "bottom-right",
    theme: (scriptEl && scriptEl.dataset.theme) || "rose",
    greeting:
      (scriptEl && scriptEl.dataset.greeting) ||
      "Hi! I'm Vera, your Virtually Ever After guide. 💍 Ask me anything!",
    botName: "Vera",
    botAvatar: "💍",
  };

  /* ───────────────────────────────────────────
     1. KNOWLEDGE BASE
  ─────────────────────────────────────────── */
  const KB = [
    /* ── What is VEA ── */
    {
      tags: ["what", "is", "virtually ever after", "about", "vea", "explain", "tell me"],
      reply: `**Virtually Ever After (VEA)** is a premium virtual wedding & celebration platform that lets couples host beautiful, interactive ceremonies online — connecting guests from anywhere in the world in real time. 🌍💑

Whether you're planning an intimate elopement or a grand celebration with hundreds of guests across continents, VEA makes it magical, personal, and stress-free.`,
    },
    /* ── Services / What can they do ── */
    {
      tags: ["service", "offer", "do", "provide", "feature", "capability", "what can", "help"],
      reply: `Here's what Virtually Ever After can do for you:

✨ **Live Virtual Ceremonies** — Stream your wedding ceremony in HD to guests worldwide
🎥 **Multi-Camera Broadcasts** — Cinematic coverage from multiple angles
💬 **Interactive Guest Experience** — Live reactions, comments & virtual toasts
🎵 **Live Music Integration** — Stream live musicians or curated playlists
📸 **Virtual Photo Booth** — Shareable moments with custom frames & filters
💐 **Décor & Theme Design** — Custom digital backdrops and branded experiences
📋 **Full Event Coordination** — Dedicated event manager from planning to finale
🌐 **Multi-Language Support** — Interpreters and subtitles for global guests
🎁 **Digital Gift Registry** — Integrated gifting experience for remote guests`,
    },
    /* ── Virtual Wedding ── */
    {
      tags: ["virtual wedding", "online wedding", "remote wedding", "digital ceremony", "ceremony"],
      reply: `VEA specialises in **virtual and hybrid weddings**! 🥂

Our ceremonies feel as real and heartfelt as in-person events:
• HD livestream to a custom branded wedding page
• Guests receive personalised digital invitations
• Interactive "front-row" seating for your closest VIPs
• Real-time vow sharing with on-screen guest reactions
• Recording delivered to you within 48 hours

No matter where your loved ones are, they'll feel like they're right there with you. 💒`,
    },
    /* ── Hybrid events ── */
    {
      tags: ["hybrid", "in-person", "physical", "mix", "both"],
      reply: `Absolutely — VEA supports **hybrid events**! 🏛️↔️💻

Combine an in-person venue with virtual attendance so everyone can join:
• Seamless sync between the live venue and the online stream
• In-venue guests and remote guests interact together
• Remote guests can throw virtual confetti and give toasts
• Works with any venue — we handle the tech setup completely`,
    },
    /* ── Pricing ── */
    {
      tags: ["price", "cost", "pricing", "package", "how much", "fee", "plan", "affordable"],
      reply: `VEA offers flexible packages to suit every couple:

💎 **Elopement** — Perfect for intimate ceremonies (up to 50 guests)
💍 **Classic** — Most popular choice (up to 200 guests)
👑 **Grand Celebration** — Full-service for 200+ guests worldwide
🛠️ **Bespoke** — Fully custom experience for unique needs

Every package includes a dedicated event coordinator, HD streaming, and post-event recording. Contact our team for a personalised quote — we love creating tailored proposals! 💌`,
    },
    /* ── How it works ── */
    {
      tags: ["how", "work", "process", "step", "start", "begin", "get started", "booking"],
      reply: `Getting started is easy! Here's the journey:

1️⃣ **Consultation** — Free discovery call with our wedding specialists
2️⃣ **Package Selection** — We craft a proposal around your vision
3️⃣ **Planning Session** — Your dedicated coordinator handles all details
4️⃣ **Tech Rehearsal** — Full run-through 48 hours before the big day
5️⃣ **Your Big Day** — We manage everything; you just enjoy the moment
6️⃣ **After Party** — Receive your full HD recording + highlights reel 🎬

Ready to begin? Reach out at **hello@virtuallyeverafter.com**!`,
    },
    /* ── Technology / Platform ── */
    {
      tags: ["tech", "platform", "technology", "app", "software", "device", "browser", "phone", "mobile"],
      reply: `VEA is **100% browser-based** — no app downloads needed! 📱💻

Guests simply click their invitation link and join instantly:
• Works on any modern browser (Chrome, Safari, Firefox, Edge)
• Mobile, tablet & desktop supported
• Reliable HD streaming even on standard home internet
• Encrypted end-to-end for privacy
• Accessible features including closed captions & sign language interpretation`,
    },
    /* ── Guest experience ── */
    {
      tags: ["guest", "attend", "join", "how do guests", "invitation"],
      reply: `Your guests will have an **amazing experience**! 🥳

• They receive a personalised digital invitation with one-click access
• No sign-up or account required — just click and join
• Choose their own "seat" in the virtual venue
• React with emoji, send messages, and participate in toasts
• Access the virtual photo booth throughout the event
• Receive a post-event highlight reel link as a keepsake

Guests from 5 continents have celebrated together on VEA! 🌍🌎🌏`,
    },
    /* ── Contact ── */
    {
      tags: ["contact", "reach", "email", "phone", "talk", "speak", "human", "person", "support"],
      reply: `We'd love to hear from you! 💌

📧 **Email:** hello@virtuallyeverafter.com
🌐 **Website:** www.virtuallyeverafter.com
📸 **Instagram:** @virtuallyeverafter
📅 **Book a free call:** www.virtuallyeverafter.com/consultation

Our team typically responds within a few hours during business days. We can't wait to be part of your special day!`,
    },
    /* ── Testimonials / Reviews ── */
    {
      tags: ["review", "testimonial", "experience", "feedback", "couple", "client", "happy", "success"],
      reply: `Couples around the world love VEA! ❤️

*"We had guests in 12 countries — VEA made it feel like everyone was in the same room. Absolutely magical."* — Sarah & James, Sydney

*"Our grandparents couldn't travel but still had the best seats in the house. We cried happy tears all day."* — Mei & Carlos, Toronto

*"The team handled every detail. On the day, we just enjoyed being married!"* — Priya & Daniel, London

Over **1,000+ couples** have celebrated with us! 🎉`,
    },
    /* ── Why choose VEA ── */
    {
      tags: ["why", "choose", "benefit", "advantage", "difference", "compare", "better", "special", "unique"],
      reply: `Here's why couples choose Virtually Ever After:

🌟 **Inclusivity** — No one misses out due to distance, disability or visa issues
💚 **Sustainable** — A smaller carbon footprint than traditional weddings
💰 **Cost-Effective** — Often significantly less than a traditional venue
🎨 **Creative Freedom** — Unique digital décor impossible in physical spaces
📹 **Always Recorded** — Never miss a moment; relive it forever
🤝 **Expert Team** — Wedding specialists with deep technical know-how
🌐 **Global Reach** — Guests across any timezone join seamlessly`,
    },
    /* ── Customisation ── */
    {
      tags: ["custom", "personalise", "theme", "decor", "design", "brand", "color", "style"],
      reply: `VEA is highly customisable to match your dream wedding aesthetic! 🎨

• Choose from 50+ digital backdrop themes or provide your own
• Brand every touchpoint with your names & wedding colours
• Custom ceremony programmes displayed for all guests
• Personalised guest welcome messages
• Branded virtual photo booth frames
• Curated music queue that reflects your story

Our design team loves collaborating on unique visions — the more creative the better! ✨`,
    },
    /* ── Elopement ── */
    {
      tags: ["elope", "elopement", "small", "intimate", "just us", "micro wedding"],
      reply: `VEA is perfect for **elopements and micro-weddings**! 💕

Whether it's just the two of you or a small circle of loved ones:
• Intimate ceremony packages from our Elopement tier
• Professional videography feel without a large crew
• Share the moment live with family who supports you from afar
• A beautiful, private, and personal experience

Some of our most moving ceremonies have been the smallest ones. 🥹`,
    },
    /* ── Rehearsal / Prep ── */
    {
      tags: ["rehearsal", "practice", "prepare", "preparation", "test", "run through"],
      reply: `We never go live without a full rehearsal! 🎭

48 hours before your ceremony, our team runs a complete technical rehearsal:
• All speakers and performers test their audio & video
• You walk through the full ceremony flow
• Officiant and couple practise their cues
• Backup protocols tested

On the day itself, our technical team is live in the background monitoring everything. You focus on your vows — we handle the rest! 💪`,
    },
    /* ── Recording / Video ── */
    {
      tags: ["record", "recording", "video", "watch", "replay", "download", "film", "footage"],
      reply: `Every VEA event is professionally recorded! 🎬

You'll receive:
• Full HD ceremony recording (delivered within 48 hours)
• Professionally edited highlights reel (2–3 minutes)
• Raw footage from all camera angles (premium packages)
• Photo gallery from virtual photo booth

Your memories, preserved beautifully — forever. 💾💍`,
    },
    /* ── Greetings ── */
    {
      tags: ["hello", "hi", "hey", "greetings", "good morning", "good afternoon", "howdy", "hiya"],
      reply: `Hello there! 👋 I'm **Vera**, the Virtually Ever After assistant.

I'm here to help you learn about our virtual wedding platform and how we can make your special day unforgettable — no matter where your guests are in the world! 🌍💍

What would you like to know?`,
    },
    /* ── Thank you ── */
    {
      tags: ["thank", "thanks", "appreciate", "helpful", "great", "awesome", "perfect", "wonderful"],
      reply: `You're so welcome! 🥰 It's my pleasure to help.

If you have more questions or are ready to take the next step, don't hesitate to ask — or reach out to our team directly at **hello@virtuallyeverafter.com**.

Wishing you all the love in the world! 💕`,
    },
    /* ── Goodbye ── */
    {
      tags: ["bye", "goodbye", "see you", "later", "ciao", "farewell", "take care"],
      reply: `Goodbye! 💍✨ Best of luck with your celebrations.

Remember, wherever love takes you — Virtually Ever After will be there to make it magical. Don't hesitate to come back with any questions!`,
    },
  ];

  /* ───────────────────────────────────────────
     2. NLP — simple weighted keyword matcher
  ─────────────────────────────────────────── */
  function tokenise(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function scoreEntry(entry, tokens) {
    let score = 0;
    for (const tag of entry.tags) {
      const tagTokens = tokenise(tag);
      // Phrase match (higher weight)
      if (tag.length > 6 && text.toLowerCase().includes(tag)) {
        score += tagTokens.length * 3;
      }
      // Token overlap
      for (const t of tagTokens) {
        if (tokens.includes(t)) score += 1;
      }
    }
    return score;
  }

  // We need `text` accessible in scoreEntry; pass it through a closure instead:
  function findBestReply(userText) {
    const tokens = tokenise(userText);
    let best = null;
    let bestScore = 0;

    for (const entry of KB) {
      let score = 0;
      for (const tag of entry.tags) {
        const tagTokens = tokenise(tag);
        // Multi-word phrase match
        if (tag.length > 5 && userText.toLowerCase().includes(tag)) {
          score += tagTokens.length * 3;
        }
        // Individual token match
        for (const t of tagTokens) {
          if (tokens.includes(t)) score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (bestScore >= 1 && best) {
      return best.reply;
    }

    // Fallback
    return `That's a great question! 😊 Our team would be happy to give you a detailed answer.

Feel free to reach out directly:
📧 **hello@virtuallyeverafter.com**
🌐 **www.virtuallyeverafter.com**

Or ask me something else — I know a lot about virtual weddings! 💍`;
  }

  /* ───────────────────────────────────────────
     3. MARKDOWN → HTML (minimal subset)
  ─────────────────────────────────────────── */
  function mdToHtml(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\n/g, "<br>");
  }

  /* ───────────────────────────────────────────
     4. STYLES
  ─────────────────────────────────────────── */
  const THEMES = {
    rose: {
      primary: "#c5687b",
      primaryDark: "#a84f63",
      primaryLight: "#fde8ed",
      accent: "#f7c5d0",
      gradient: "linear-gradient(135deg, #c5687b 0%, #e8a0b0 100%)",
    },
    gold: {
      primary: "#b8922a",
      primaryDark: "#9a7820",
      primaryLight: "#fdf3dc",
      accent: "#f0d88a",
      gradient: "linear-gradient(135deg, #b8922a 0%, #d4b054 100%)",
    },
    sage: {
      primary: "#6a9b7c",
      primaryDark: "#527a61",
      primaryLight: "#e8f4ec",
      accent: "#b5d9c2",
      gradient: "linear-gradient(135deg, #6a9b7c 0%, #92c4a5 100%)",
    },
  };

  const T = THEMES[CFG.theme] || THEMES.rose;

  const CSS = `
    #vea-chat-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: ${T.gradient};
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.22);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      outline: none;
    }
    #vea-chat-fab:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 28px rgba(0,0,0,0.28);
    }
    #vea-chat-fab:active { transform: scale(0.96); }

    #vea-chat-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 18px;
      height: 18px;
      background: #e74c3c;
      border-radius: 50%;
      border: 2px solid #fff;
      font-size: 10px;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-family: sans-serif;
    }

    #vea-chat-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      z-index: 99998;
      width: 360px;
      max-width: calc(100vw - 32px);
      height: 520px;
      max-height: calc(100vh - 120px);
      border-radius: 18px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transform-origin: bottom right;
      transition: transform 0.28s cubic-bezier(0.34,1.56,0.64,1), opacity 0.22s ease;
    }
    #vea-chat-window.vea-hidden {
      transform: scale(0.75) translateY(20px);
      opacity: 0;
      pointer-events: none;
    }

    #vea-chat-header {
      background: ${T.gradient};
      color: #fff;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    #vea-chat-header-avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }
    #vea-chat-header-info { flex: 1; min-width: 0; }
    #vea-chat-header-name {
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.01em;
    }
    #vea-chat-header-status {
      font-size: 11px;
      opacity: 0.85;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 1px;
    }
    .vea-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4cdd80;
      flex-shrink: 0;
    }
    #vea-chat-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px;
      border-radius: 50%;
      transition: background 0.15s, color 0.15s;
    }
    #vea-chat-close:hover {
      background: rgba(255,255,255,0.2);
      color: #fff;
    }

    #vea-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
      background: #fafafa;
    }
    #vea-chat-messages::-webkit-scrollbar { width: 5px; }
    #vea-chat-messages::-webkit-scrollbar-thumb {
      background: ${T.accent};
      border-radius: 3px;
    }

    .vea-msg {
      display: flex;
      gap: 8px;
      max-width: 88%;
      animation: veaFadeUp 0.25s ease both;
    }
    @keyframes veaFadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .vea-msg.vea-bot { align-self: flex-start; }
    .vea-msg.vea-user { align-self: flex-end; flex-direction: row-reverse; }

    .vea-msg-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: ${T.primaryLight};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .vea-msg-bubble {
      padding: 9px 13px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.5;
      max-width: 100%;
      word-wrap: break-word;
    }
    .vea-bot .vea-msg-bubble {
      background: #fff;
      color: #333;
      border: 1px solid #ece8f0;
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .vea-user .vea-msg-bubble {
      background: ${T.gradient};
      color: #fff;
      border-bottom-right-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.14);
    }
    .vea-user .vea-msg-bubble strong { color: #fff; }

    /* Quick replies */
    #vea-quick-replies {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 12px 0;
      flex-shrink: 0;
    }
    .vea-qr {
      background: ${T.primaryLight};
      color: ${T.primaryDark};
      border: 1px solid ${T.accent};
      border-radius: 14px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, transform 0.1s;
      white-space: nowrap;
      font-family: inherit;
    }
    .vea-qr:hover {
      background: ${T.primary};
      color: #fff;
      transform: translateY(-1px);
    }

    /* Typing indicator */
    .vea-typing {
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 10px 13px;
    }
    .vea-typing span {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: ${T.accent};
      animation: veaBounce 1.2s infinite ease-in-out;
    }
    .vea-typing span:nth-child(2) { animation-delay: 0.2s; }
    .vea-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes veaBounce {
      0%, 60%, 100% { transform: translateY(0); }
      30%            { transform: translateY(-6px); }
    }

    #vea-chat-input-area {
      padding: 10px 12px 12px;
      border-top: 1px solid #eee;
      display: flex;
      gap: 8px;
      align-items: flex-end;
      background: #fff;
      flex-shrink: 0;
    }
    #vea-chat-input {
      flex: 1;
      border: 1.5px solid #ddd;
      border-radius: 20px;
      padding: 9px 14px;
      font-size: 13.5px;
      outline: none;
      resize: none;
      font-family: inherit;
      line-height: 1.4;
      max-height: 80px;
      overflow-y: auto;
      transition: border-color 0.2s;
    }
    #vea-chat-input:focus { border-color: ${T.primary}; }
    #vea-chat-input::placeholder { color: #aaa; }

    #vea-chat-send {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: ${T.gradient};
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: transform 0.15s, opacity 0.15s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    #vea-chat-send:hover { transform: scale(1.08); }
    #vea-chat-send:active { transform: scale(0.95); }
    #vea-chat-send svg { fill: #fff; }

    #vea-chat-branding {
      text-align: center;
      font-size: 10px;
      color: #bbb;
      padding: 4px 0 8px;
      background: #fff;
      flex-shrink: 0;
    }
    #vea-chat-branding a { color: #bbb; text-decoration: none; }

    @media (max-width: 420px) {
      #vea-chat-window {
        right: 0;
        bottom: 0;
        width: 100vw;
        max-width: 100vw;
        height: 100dvh;
        max-height: 100dvh;
        border-radius: 0;
      }
      #vea-chat-fab { bottom: 16px; right: 16px; }
    }
  `;

  /* ───────────────────────────────────────────
     5. QUICK REPLIES (shown after greeting)
  ─────────────────────────────────────────── */
  const QUICK_REPLIES = [
    "What is Virtually Ever After?",
    "What services do you offer?",
    "How does it work?",
    "Pricing & packages",
    "Contact the team",
  ];

  /* ───────────────────────────────────────────
     6. BUILD DOM
  ─────────────────────────────────────────── */
  function buildWidget() {
    // Inject CSS
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // FAB button
    const fab = document.createElement("button");
    fab.id = "vea-chat-fab";
    fab.setAttribute("aria-label", "Chat with Virtually Ever After");
    fab.innerHTML = `<span style="font-size:28px">💍</span>`;

    const badge = document.createElement("span");
    badge.id = "vea-chat-badge";
    badge.textContent = "1";
    fab.appendChild(badge);

    // Chat window
    const win = document.createElement("div");
    win.id = "vea-chat-window";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", "Virtually Ever After chat");
    win.classList.add("vea-hidden");

    win.innerHTML = `
      <div id="vea-chat-header">
        <div id="vea-chat-header-avatar">${CFG.botAvatar}</div>
        <div id="vea-chat-header-info">
          <div id="vea-chat-header-name">${CFG.botName} · Virtually Ever After</div>
          <div id="vea-chat-header-status">
            <span class="vea-status-dot"></span> Online &amp; ready to help
          </div>
        </div>
        <button id="vea-chat-close" aria-label="Close chat">✕</button>
      </div>
      <div id="vea-chat-messages" role="log" aria-live="polite"></div>
      <div id="vea-quick-replies"></div>
      <div id="vea-chat-input-area">
        <textarea id="vea-chat-input"
          placeholder="Ask me anything…"
          rows="1"
          aria-label="Type your message"></textarea>
        <button id="vea-chat-send" aria-label="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
      <div id="vea-chat-branding">Powered by <a href="https://virtuallyeverafter.com" target="_blank">Virtually Ever After</a></div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(win);

    return {
      fab,
      badge,
      win,
      messages: win.querySelector("#vea-chat-messages"),
      quickReplies: win.querySelector("#vea-quick-replies"),
      input: win.querySelector("#vea-chat-input"),
      sendBtn: win.querySelector("#vea-chat-send"),
      closeBtn: win.querySelector("#vea-chat-close"),
    };
  }

  /* ───────────────────────────────────────────
     7. MESSAGING LOGIC
  ─────────────────────────────────────────── */
  function appendMessage(el, role, htmlContent) {
    const isBot = role === "bot";
    const msg = document.createElement("div");
    msg.className = `vea-msg ${isBot ? "vea-bot" : "vea-user"}`;

    if (isBot) {
      msg.innerHTML = `
        <div class="vea-msg-avatar">${CFG.botAvatar}</div>
        <div class="vea-msg-bubble">${htmlContent}</div>
      `;
    } else {
      msg.innerHTML = `
        <div class="vea-msg-bubble">${htmlContent}</div>
        <div class="vea-msg-avatar">🙂</div>
      `;
    }

    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;
    return msg;
  }

  function showTyping(el) {
    const typingMsg = document.createElement("div");
    typingMsg.className = "vea-msg vea-bot";
    typingMsg.innerHTML = `
      <div class="vea-msg-avatar">${CFG.botAvatar}</div>
      <div class="vea-msg-bubble vea-typing">
        <span></span><span></span><span></span>
      </div>
    `;
    el.appendChild(typingMsg);
    el.scrollTop = el.scrollHeight;
    return typingMsg;
  }

  function showQuickReplies(container, replies, handler) {
    container.innerHTML = "";
    for (const r of replies) {
      const btn = document.createElement("button");
      btn.className = "vea-qr";
      btn.textContent = r;
      btn.addEventListener("click", () => handler(r));
      container.appendChild(btn);
    }
  }

  function clearQuickReplies(container) {
    container.innerHTML = "";
  }

  /* ───────────────────────────────────────────
     8. INIT & EVENT WIRING
  ─────────────────────────────────────────── */
  function init() {
    const ui = buildWidget();
    let isOpen = false;
    let greeted = false;

    function open() {
      isOpen = true;
      ui.win.classList.remove("vea-hidden");
      ui.badge.style.display = "none";
      ui.fab.innerHTML = `<span style="font-size:22px">✕</span>`;
      ui.input.focus();

      if (!greeted) {
        greeted = true;
        setTimeout(() => {
          const typing = showTyping(ui.messages);
          setTimeout(() => {
            typing.remove();
            appendMessage(ui.messages, "bot", mdToHtml(CFG.greeting));
            showQuickReplies(ui.quickReplies, QUICK_REPLIES, handleSend);
          }, 900);
        }, 200);
      }
    }

    function close() {
      isOpen = false;
      ui.win.classList.add("vea-hidden");
      ui.fab.innerHTML = `<span style="font-size:28px">💍</span>`;
    }

    function handleSend(text) {
      text = (text || ui.input.value).trim();
      if (!text) return;

      clearQuickReplies(ui.quickReplies);
      appendMessage(ui.messages, "user", escapeHtml(text));
      ui.input.value = "";
      ui.input.style.height = "auto";

      const typing = showTyping(ui.messages);
      const delay = 600 + Math.random() * 700;

      setTimeout(() => {
        typing.remove();
        const reply = findBestReply(text);
        appendMessage(ui.messages, "bot", mdToHtml(reply));
      }, delay);
    }

    ui.fab.addEventListener("click", () => (isOpen ? close() : open()));
    ui.closeBtn.addEventListener("click", close);

    ui.sendBtn.addEventListener("click", () => handleSend());

    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Auto-grow textarea
    ui.input.addEventListener("input", () => {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, 80) + "px";
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) close();
    });
  }

  /* ───────────────────────────────────────────
     UTIL: HTML escape for user input
  ─────────────────────────────────────────── */
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* ───────────────────────────────────────────
     BOOT
  ─────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
