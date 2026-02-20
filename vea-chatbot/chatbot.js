/**
 * Virtually Ever After — Embedded Chatbot Widget
 * Zero dependencies · No API key · No backend
 *
 * Usage (drop one tag anywhere):
 *   <script src="chatbot.js"></script>
 *
 * Optional data-* overrides:
 *   data-theme="dark|light"
 *   data-greeting="Custom greeting text"
 */
(function () {
  "use strict";

  /* ─────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────── */
  const scriptEl =
    document.currentScript ||
    document.querySelector('script[src*="chatbot.js"]');

  const CFG = {
    theme:    (scriptEl && scriptEl.dataset.theme)    || "light",
    greeting: (scriptEl && scriptEl.dataset.greeting) ||
      "Hello — I'm Vera, your guide to Virtually Ever After.\nWhat can I help you explore?",
    botName:  "Vera · VEA",
  };

  /* ─────────────────────────────────────────
     KNOWLEDGE BASE
     Each entry: { tags[], reply, next[] }
     next[] = quick-reply suggestions after this answer
  ───────────────────────────────────────── */
  const KB = [

    /* ── GREETINGS ── */
    {
      tags: ["hello","hi","hey","hiya","good morning","good afternoon","good evening","greetings","howdy","salut","ciao","merhaba"],
      reply: `Hello — welcome to **Virtually Ever After**.

We're a creative studio at the intersection of architecture, spatial design, and digital technology. We build the digital worlds that your brand or project lives in.

How can I help you today?`,
      next: ["What is VEA?", "What services do you offer?", "Show me your work", "Who founded VEA?"],
    },

    /* ── WHAT IS VEA ── */
    {
      tags: ["what is","what are","about","vea","virtually ever after","explain","tell me","overview","who are you","describe","introduce"],
      reply: `**Virtually Ever After (VEA)** is a creative platform that reimagines how we experience architecture and space in the digital age.

Founded in Luxembourg, the studio blends **spatial design**, **real-time 3D environments**, and emerging technologies like AI and WebXR to craft immersive, interactive experiences that go far beyond traditional visualisations.

Our mission is to dissolve the boundaries between physical and digital spaces — turning static environments into living, navigable, story-driven worlds.

We work with architects, developers, curators, brands, and institutions ready to embrace the future of spatial storytelling.

> *"VEA combines architecture and storytelling into a multidimensional universe for each individual story."*`,
      next: ["What services do you offer?", "Who founded VEA?", "Show me your work", "Who is VEA for?"],
    },

    /* ── SERVICES OVERVIEW ── */
    {
      tags: ["service","offer","what do you do","what can you do","help","capability","capabilities","provide","work","what you do"],
      reply: `VEA's work spans three core disciplines:

**01 — Worldbuilding**
We design the digital space a studio or brand inhabits — from atmospheric spatial interfaces and interactive 3D websites to hybrid galleries and archive mappings.

**02 — Identity Building**
We construct brand codes built for spatial and digital environments. Logo design, brand identity, and consistent visual systems — designed with architectural precision.

**03 — Digital Content**
Cinematic reels, visual storytelling, creative direction. We translate architectural and design work into narratives that connect — the lines people feel but usually miss.

Which area is most relevant to what you're building?`,
      next: ["Tell me about Worldbuilding", "Tell me about Identity Building", "Tell me about Digital Content", "Show me your work"],
    },

    /* ── WORLDBUILDING ── */
    {
      tags: ["worldbuilding","world building","3d website","spatial","metaverse","spatial web","interactive website","immersive","xr","webxr","three.js","threejs","virtual space","digital space","gamif","walk inside"],
      reply: `**Worldbuilding** is VEA's core discipline — designing the digital "space" a studio lives in.

Think of it as architecture, but for the web:

— **Atmospheric Spatial Interfaces** — Websites users walk inside and interact with. Objects become smart. Navigation becomes experience. Gamification of space.

— **Web-based 3D Interactivity** — A framed narrative to showcase any design from multiple dimensions. Built with Three.js, WebXR, and custom rendering pipelines.

— **Hybrid Spatial Gallery** — The medium between a flat 2D site and a fully interactive environment. Carefully calibrated for the project's context.

— **Index as Mapping** — Re-organisation of a library or portfolio as a single navigable layout — where the relationship between works becomes as important as the works themselves.

We've built spatial worlds for fashion brands, architecture studios, and cultural institutions. Want to tell me about your project?`,
      next: ["Tell me about Identity Building", "Tell me about Digital Content", "Show me your work", "How do we start?"],
    },

    /* ── IDENTITY BUILDING ── */
    {
      tags: ["identity","brand","logo","branding","visual identity","brand identity","design system","brand code","typography","consistent","aesthetic","visual"],
      reply: `**Identity Building** at VEA means constructing brand codes specifically for spatial and digital environments.

Architectural precision applied to visual language — ensuring a solid foundation for brands that exist in both physical and digital space.

— **Logo Design** — Marks that hold meaning at every scale, from a screen pixel to a 3-metre installation.

— **Brand Identity Systems** — Colour, typography, spatial grammar, and motion logic developed as a unified system.

— **Consistent Aesthetics** — VEA acts as the messenger between maker and audience. Every touchpoint carries the same intentionality — packaging, digital, physical, motion.

— **Booklet & Publication Design** — Curating digital and physical documentation as art objects. Bridging visualisation with tactile literature.

We built the full identity for **Status CO** — from logo through to 3D space design and packaging — and the "clockwork" visual identity for **Decentralize Design**.

What kind of project are you working on?`,
      next: ["Tell me about Worldbuilding", "Tell me about Digital Content", "Show me your work", "How do we start?"],
    },

    /* ── DIGITAL CONTENT ── */
    {
      tags: ["content","video","reel","film","cinematic","motion","storytelling","direction","art direction","creative direction","photography","visual","narrative","documentation"],
      reply: `**Digital Content** is how VEA translates solid work into living narrative.

— **Cinematic Reels & Video** — Short-form architectural and design films crafted for contemporary media. Not just renderings — compact visual stories built around proportion, light, and spatial sequence.

— **Visual Storytelling** — The line that connects dots people usually miss but feel subconsciously. We find the story underneath the project.

— **Creative Direction** — Art direction for digital and physical presentations, ensuring every visual output is conceptually grounded.

— **Exhibition Design** — The physical manifestation of digital thinking. We translate volumetric concepts into tangible spaces for events and presentations.

For **Novantatre**, we produced architectural film reels that guided the viewer through drawings and spatial layers in an archive-like sequence. For **DAS Pieces**, we built a visual world around a lamp collection that expressed the brand's relationship with light.

What are you looking to communicate?`,
      next: ["Tell me about Worldbuilding", "Tell me about Identity Building", "Show me your work", "How do we start?"],
    },

    /* ── PROJECTS / WORK ── */
    {
      tags: ["project","work","portfolio","case study","example","previous","past","client","reference","show","done","built","made"],
      reply: `Here's a selection of VEA's recent work:

**Status CO** — 2026
Interactive website · 3D exhibition environment · Logo · Brand identity · Packaging · Motion reels. We translated the brand's concept into a unified spatial, digital, and experiential system. Positioned as a collectible archive.
↗ status-co.com

**Novantatre** — 2025–2026
Series of architectural film reels for a Luxembourg architecture studio. Sequential, archive-like narratives guiding the viewer through spatial layers, drawings, and materiality.
↗ novantatre.lu

**DAS Pieces** — 2025
Digital narrative for a lamp collection. A visual world that situates each piece within its own atmosphere — expressing the brand's relationship with light.
↗ daspieces.com

**Laila** — 2026
Landing page for an action-first NYC dating app. Cinematic interface with fluid motion and interactive date archives — positioned as a premium lifestyle destination, not a utility.
↗ laila.nyc

**Decentralize Design** — 2025
Interactive website · Logo · "Clockwork" visual identity · 2-minute cinematic showcase. A detailed visual narrative merging motion graphics with spatial documentation.
↗ decentralize.design

Is any of these close to what you have in mind?`,
      next: ["Tell me more about Status CO", "Tell me more about Laila", "What services do you offer?", "How do we start?"],
    },

    /* ── STATUS CO ── */
    {
      tags: ["status co","status_co","statco"],
      reply: `**Status CO** is one of VEA's most complete collaborations.

During a key development phase, VEA translated the brand's concept into a cohesive spatial, digital, and experiential system:

— 3D exhibition environment and 3D website — a unified space where objects, narrative, and interaction operate together
— Motion reels and digital content for platform presence
— Corporate identity framework and packaging system for consistency across every touchpoint
— From DROP 001 storytelling to material applications — the brand was positioned as a **collectible archive** rather than a conventional product line

↗ status-co.com`,
      next: ["Show me your work", "What services do you offer?", "How do we start?"],
    },

    /* ── LAILA ── */
    {
      tags: ["laila","dating","nyc","new york"],
      reply: `**Laila** is a dating app built around action — not swiping.

VEA collaborated to translate their philosophy into a digital gateway that captures the restless pulse of New York City:

— Seamless, cinematic interface where fluid motion and interactive date archives replace the friction of traditional apps
— Sophisticated nocturnal aesthetic with an intuitive user journey
— Positioned as a **premium lifestyle destination**, not a conventional utility

↗ laila.nyc`,
      next: ["Show me your work", "What services do you offer?", "How do we start?"],
    },

    /* ── NOVANTATRE ── */
    {
      tags: ["novantatre","film reel","architectural film","architecture film"],
      reply: `**Novantatre** is a Luxembourg architecture studio. VEA produced a series of short architectural film reels presenting selected projects in cinematic format:

— One film structured the project as a **sequential, archive-like narrative** — guiding the viewer step by step through drawings and spatial layers
— Another explored the building through **controlled camera movement and façade transformation**, emphasising proportion, detail, and materiality
— Designed as compact visual stories for contemporary media — not static renderings

↗ novantatre.lu`,
      next: ["Tell me about Digital Content", "Show me your work", "How do we start?"],
    },

    /* ── DAS PIECES ── */

    {
      tags: ["das pieces","das","lamp","product","collection","minimal","light"],
      reply: `**DAS Pieces** is a minimal lamp collection. VEA's collaboration reinterpreted the collection through a digital narrative lens:

— A visual world was constructed that situates **each piece within its own atmosphere**
— Not simply product presentation — but the expression of the brand's design philosophy and its relationship with light in a broader spatial perspective
— The brand's **timeless and understated identity** translated into a carefully constructed digital setting

↗ daspieces.com`,
      next: ["Tell me about Digital Content", "Show me your work", "How do we start?"],
    },

    /* ── DECENTRALIZE DESIGN ── */
    {
      tags: ["decentralize","decentralize design","clockwork","spatial documentation"],
      reply: `**Decentralize Design** is a spatial design studio. VEA built their complete digital presence:

— "**Clockwork**" visual identity — the studio's signature mark
— Interactive website and logo
— A **2-minute cinematic showcase** that deconstructs their technical process in virtual world-building
— Precise motion graphics merged with spatial documentation to articulate the studio's role in complex digital environments

↗ decentralize.design`,
      next: ["Tell me about Identity Building", "Show me your work", "How do we start?"],
    },

    /* ── FOUNDER ── */
    {
      tags: ["founder","deniz","agaoglu","who","person","team","behind","architect","founded","creator"],
      reply: `VEA was founded by **Deniz Agaoglu** — architect and digital designer exploring the intersection between physical spaces and virtual environments.

Born in Alanya in 1995, she holds:
— Bachelor's degree in Architecture, **Istanbul Bilgi University**
— Master's degree in Architecture and Urban Design, **Politecnico di Milano**

Her professional journey began at **co.arch studio** in Milan, contributing to projects from furniture design to urban-scale interventions. In 2022, she relocated to **Luxembourg**, developing a strong focus on digital design and immersive storytelling.

In 2025, Deniz founded Virtually Ever After — a practice dedicated to crafting sensorial, narrative-driven virtual spaces. Through a multidisciplinary approach merging **architecture, technology, and visual culture**, her work bridges the tangible and the digital.

She collaborates internationally with architects, cultural institutions, and creatives.`,
      next: ["What is VEA?", "Show me your work", "How do we start?"],
    },

    /* ── WHERE / LOCATION ── */
    {
      tags: ["where","location","based","luxembourg","city","country","office","studio"],
      reply: `VEA is based in **Luxembourg** 🇱🇺, with an international scope — collaborating with architects, brands, and institutions across Europe and beyond.

The studio operates remotely and on-site depending on the project's nature.`,
      next: ["What is VEA?", "How do we start?", "Contact & pricing"],
    },

    /* ── WHO IS VEA FOR ── */
    {
      tags: ["who is","for who","for whom","target","client","suitable","right for","audience","architect","brand","institution","developer"],
      reply: `VEA works at the intersection of design and technology — the studio's clients share one thing in common: **a project that deserves more than a standard presentation**.

Our collaborators include:

— **Architecture studios** looking to present work cinematically or spatially online
— **Fashion and product brands** building a digital world around their objects
— **Cultural institutions** exploring immersive or interactive exhibition formats
— **Tech companies and startups** that need spatial or editorial digital identities
— **Creatives and makers** who want their portfolio to function as an experience, not a catalogue

If your project has a spatial dimension — physical or conceptual — VEA can give it a digital life.

What kind of project are you working on?`,
      next: ["What services do you offer?", "Show me your work", "How do we start?"],
    },

    /* ── TECHNOLOGY STACK ── */
    {
      tags: ["tech","technology","stack","three.js","webxr","ai","tools","platform","framework","build","code","engine"],
      reply: `VEA's technical toolkit is assembled around the specifics of each project — we don't apply one-size solutions.

Core technologies include:

— **Three.js** — real-time 3D rendering in the browser, no plugin required
— **WebXR** — immersive VR/AR experiences on the open web
— **Custom AI integrations** — generative and interactive layers within spatial interfaces
— **GSAP & motion libraries** — precise, high-quality animation and transitions
— **Framer, Webflow, custom builds** — depending on the project's editorial or interactive needs

Every project is browser-based. No app downloads, no hardware dependency.`,
      next: ["Tell me about Worldbuilding", "What services do you offer?", "How do we start?"],
    },

    /* ── PROCESS / HOW IT WORKS ── */
    {
      tags: ["process","how","work together","collaboration","approach","method","step","begin","workflow","timeline","start","getting started"],
      reply: `VEA's process is built around **close collaboration** — every project is treated as a unique narrative.

**01 Discovery**
A focused conversation to understand your project, its context, and what it needs to communicate. We listen before we propose.

**02 Concept**
We develop a clear spatial and editorial concept — what the experience will feel like, not just look like. Presented for your feedback before a line of code or frame is rendered.

**03 Production**
Design, build, and content production run in parallel. You receive progress updates and review stages throughout.

**04 Delivery & Beyond**
Final delivery — website, video, identity, or all three. We remain available for iterations, expansions, and future phases.

The best place to start is a conversation. Want to tell me about your project?`,
      next: ["How do we start?", "Contact & pricing", "Show me your work"],
    },

    /* ── PRICING ── */
    {
      tags: ["price","pricing","cost","how much","fee","budget","rate","quote","package","afford","charge","invoice"],
      reply: `Pricing at VEA is **project-specific** — we don't work with fixed packages, because no two projects have the same scope.

What shapes a proposal:
— The type of deliverable (3D website, cinematic reel, full identity, or a combination)
— The scale of the project and the timeline
— The level of creative direction involved

The best first step is a **brief conversation** — it takes 20 minutes and gives us everything we need to send a clear, honest proposal.

Reach out at **hello@virtuallyeverafter.xyz** or through the contact form on the site. We typically respond within one business day.`,
      next: ["How do we start?", "What services do you offer?", "Show me your work"],
    },

    /* ── CONTACT ── */
    {
      tags: ["contact","reach","email","phone","message","talk","connect","get in touch","speak","meet","book","call","inquiry","enquiry","hello"],
      reply: `To start a conversation with VEA:

📧 **hello@virtuallyeverafter.xyz**
🌐 **virtuallyeverafter.xyz**

We respond to all enquiries within one business day. Whether you have a detailed brief or just the beginning of an idea — we're glad to hear it.`,
      next: ["How do we start?", "What services do you offer?", "Show me your work"],
    },

    /* ── EXHIBITION / PHYSICAL ── */
    {
      tags: ["exhibition","exhibit","physical","installation","space","pop up","popup","pop-up","gallery","event","show","fair","venue"],
      reply: `VEA brings digital thinking into physical space through **Exhibition Design** and **Pop-up Space Design**.

This is the physical manifestation of what we do digitally — transforming volumetric concepts and spatial narratives into tangible environments for events, openings, and installations.

For **Status CO**, VEA designed the pop-up space alongside the digital experience — creating continuity between what visitors encounter online and in person.

If you're planning an event or installation, it's worth exploring how the digital and physical can speak the same spatial language.`,
      next: ["What services do you offer?", "Show me your work", "How do we start?"],
    },

    /* ── PRODUCT DESIGN ── */
    {
      tags: ["product design","product","object","form","industrial","furniture","physical product","material"],
      reply: `**Product Design** at VEA bridges the gap between pure utility and human interaction — through carefully engineered forms and intentional materiality.

This service complements VEA's spatial and identity work: when a brand's physical object needs to carry the same intentionality as its digital presence.

If you're working on a product that needs both design and narrative, let's talk.`,
      next: ["Tell me about Identity Building", "What services do you offer?", "How do we start?"],
    },

    /* ── THANKS ── */
    {
      tags: ["thank","thanks","thank you","merci","grazie","teşekkür","appreciate","helpful","great","awesome","perfect","wonderful","brilliant"],
      reply: `You're welcome — it's what we're here for.

If you're ready to take the next step or have more questions, don't hesitate. The best ideas often start with a simple conversation.

📧 hello@virtuallyeverafter.xyz`,
      next: ["How do we start?", "What services do you offer?", "Show me your work"],
    },

    /* ── GOODBYE ── */
    {
      tags: ["bye","goodbye","see you","later","ciao","farewell","take care","adieu","auf wiedersehen","quit","close"],
      reply: `Until next time.

If something comes up — a project, a question, or just a vague idea — we're at **hello@virtuallyeverafter.xyz**.

Take care.`,
      next: [],
    },

  ]; // end KB

  /* ─────────────────────────────────────────
     NLP — weighted keyword matcher
  ───────────────────────────────────────── */
  function tokenise(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function findBestEntry(userText) {
    const lower   = userText.toLowerCase();
    const tokens  = tokenise(userText);
    let best      = null;
    let bestScore = 0;

    for (const entry of KB) {
      let score = 0;
      for (const tag of entry.tags) {
        // Multi-word phrase match (higher weight)
        if (tag.includes(" ") && lower.includes(tag)) {
          score += tag.split(" ").length * 4;
        } else if (tokens.includes(tag)) {
          score += 2;
        }
        // Partial token overlap for single-word tags
        for (const t of tokens) {
          if (t.length > 3 && tag.startsWith(t)) score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (bestScore >= 2 && best) return best;
    return null;
  }

  /* ─────────────────────────────────────────
     MARKDOWN → HTML (bold, italic, blockquote, newlines)
  ───────────────────────────────────────── */
  function mdToHtml(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,     "<em>$1</em>")
      .replace(/^> (.+)$/gm,     "<blockquote>$1</blockquote>")
      .replace(/↗ ([^\n]+)/g,    '<span class="vea-link">↗ $1</span>')
      .replace(/\n/g,            "<br>");
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;")
      .replace(/'/g,  "&#039;");
  }

  /* ─────────────────────────────────────────
     THEMES
  ───────────────────────────────────────── */
  const THEMES = {
    dark: {
      bg:          "#0e0e0e",
      surface:     "#161616",
      surfaceHover:"#1e1e1e",
      border:      "rgba(255,255,255,0.08)",
      text:        "#e8e8e8",
      muted:       "#888",
      accent:      "#c8b89a",
      accentDark:  "#a89070",
      userBubble:  "#1e1e1e",
      userText:    "#e8e8e8",
      botBubble:   "#111111",
      botText:     "#d8d8d8",
      headerBg:    "#111111",
      inputBg:     "#0e0e0e",
      inputBorder: "rgba(255,255,255,0.12)",
      scrollThumb: "rgba(255,255,255,0.1)",
      qrBg:        "rgba(200,184,154,0.08)",
      qrBorder:    "rgba(200,184,154,0.2)",
      qrText:      "#c8b89a",
      qrHoverBg:   "#c8b89a",
      qrHoverText: "#0e0e0e",
      fabBg:       "#1a1a1a",
      fabBorder:   "rgba(200,184,154,0.3)",
      fabColor:    "#c8b89a",
      shadow:      "0 24px 64px rgba(0,0,0,0.6)",
    },
    light: {
      bg:          "#ffffff",
      surface:     "#f8f7f5",
      surfaceHover:"#f0ede8",
      border:      "rgba(0,0,0,0.08)",
      text:        "#111111",
      muted:       "#888",
      accent:      "#8a7055",
      accentDark:  "#6a5035",
      userBubble:  "#111111",
      userText:    "#ffffff",
      botBubble:   "#f0ede8",
      botText:     "#222222",
      headerBg:    "#111111",
      inputBg:     "#ffffff",
      inputBorder: "rgba(0,0,0,0.12)",
      scrollThumb: "rgba(0,0,0,0.1)",
      qrBg:        "rgba(138,112,85,0.06)",
      qrBorder:    "rgba(138,112,85,0.2)",
      qrText:      "#8a7055",
      qrHoverBg:   "#8a7055",
      qrHoverText: "#ffffff",
      fabBg:       "#111111",
      fabBorder:   "rgba(0,0,0,0)",
      fabColor:    "#ffffff",
      shadow:      "0 16px 48px rgba(0,0,0,0.18)",
    },
  };

  const T = THEMES[CFG.theme] || THEMES.dark;

  /* ─────────────────────────────────────────
     CSS
  ───────────────────────────────────────── */
  const CSS = `
    #vea-fab {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 99999;
      width: 54px;
      height: 54px;
      border-radius: 50%;
      background: ${T.fabBg};
      border: 1px solid ${T.fabBorder};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: ${T.shadow};
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      outline: none;
      color: ${T.fabColor};
    }
    #vea-fab:hover {
      transform: scale(1.06);
    }
    #vea-fab:active {
      transform: scale(0.96);
    }
    #vea-fab-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.15s;
    }

    #vea-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: ${T.accent};
      border: 2px solid ${T.fabBg};
    }

    #vea-window {
      position: fixed;
      bottom: 96px;
      right: 28px;
      z-index: 99998;
      width: 380px;
      max-width: calc(100vw - 40px);
      height: 560px;
      max-height: calc(100dvh - 120px);
      background: ${T.bg};
      border: 1px solid ${T.border};
      border-radius: 16px;
      box-shadow: ${T.shadow};
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      transform-origin: bottom right;
      transition: transform 0.3s cubic-bezier(0.34, 1.5, 0.64, 1), opacity 0.2s ease;
    }
    #vea-window.vea-closed {
      transform: scale(0.85) translateY(16px);
      opacity: 0;
      pointer-events: none;
    }

    /* ── Header ── */
    #vea-header {
      background: ${T.headerBg};
      padding: 16px 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      border-bottom: 1px solid ${T.border};
    }
    #vea-header-mark {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: rgba(200,184,154,0.12);
      border: 1px solid rgba(200,184,154,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    #vea-header-mark svg {
      width: 16px;
      height: 16px;
      fill: ${T.accent};
    }
    #vea-header-info {
      flex: 1;
    }
    #vea-header-name {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      letter-spacing: 0.02em;
    }
    #vea-header-sub {
      font-size: 11px;
      color: rgba(255,255,255,0.4);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .vea-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #5adf88;
      flex-shrink: 0;
    }
    #vea-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.35);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 6px;
      transition: background 0.15s, color 0.15s;
      font-family: inherit;
    }
    #vea-close:hover {
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.7);
    }

    /* ── Messages ── */
    #vea-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }
    #vea-msgs::-webkit-scrollbar { width: 4px; }
    #vea-msgs::-webkit-scrollbar-track { background: transparent; }
    #vea-msgs::-webkit-scrollbar-thumb {
      background: ${T.scrollThumb};
      border-radius: 2px;
    }

    .vea-row {
      display: flex;
      gap: 10px;
      max-width: 92%;
      animation: veaIn 0.22s ease both;
    }
    @keyframes veaIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .vea-row.vea-bot  { align-self: flex-start; }
    .vea-row.vea-user { align-self: flex-end; flex-direction: row-reverse; }

    .vea-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(200,184,154,0.1);
      border: 1px solid rgba(200,184,154,0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .vea-avatar svg { width: 13px; height: 13px; fill: ${T.accent}; }
    .vea-avatar-user { background: rgba(255,255,255,0.06); border-color: ${T.border}; }
    .vea-avatar-user svg { fill: ${T.muted}; }

    .vea-bubble {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13.5px;
      line-height: 1.6;
      max-width: 100%;
      word-wrap: break-word;
    }
    .vea-bot .vea-bubble {
      background: ${T.botBubble};
      color: ${T.botText};
      border: 1px solid ${T.border};
      border-bottom-left-radius: 3px;
    }
    .vea-bot .vea-bubble strong { color: ${T.text}; }
    .vea-bot .vea-bubble blockquote {
      margin: 6px 0 0;
      padding: 6px 10px;
      border-left: 2px solid ${T.accent};
      color: ${T.muted};
      font-style: italic;
      font-size: 12.5px;
    }
    .vea-bot .vea-bubble .vea-link {
      color: ${T.accent};
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    .vea-user .vea-bubble {
      background: ${T.userBubble};
      color: ${T.userText};
      border: 1px solid rgba(255,255,255,0.06);
      border-bottom-right-radius: 3px;
    }

    /* ── Typing indicator ── */
    .vea-typing {
      display: flex;
      gap: 5px;
      align-items: center;
      padding: 12px 14px;
    }
    .vea-typing span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: ${T.accent};
      opacity: 0.5;
      animation: veaBounce 1.1s infinite ease-in-out;
    }
    .vea-typing span:nth-child(2) { animation-delay: 0.18s; }
    .vea-typing span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes veaBounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
      30%            { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Quick replies ── */
    #vea-qr {
      padding: 8px 16px 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      flex-shrink: 0;
    }
    .vea-qr-btn {
      background: ${T.qrBg};
      border: 1px solid ${T.qrBorder};
      color: ${T.qrText};
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
      white-space: nowrap;
      font-family: inherit;
      letter-spacing: 0.01em;
    }
    .vea-qr-btn:hover {
      background: ${T.qrHoverBg};
      color: ${T.qrHoverText};
      border-color: transparent;
      transform: translateY(-1px);
    }

    /* ── Input area ── */
    #vea-input-area {
      padding: 10px 14px 14px;
      border-top: 1px solid ${T.border};
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
      background: ${T.bg};
    }
    #vea-input {
      flex: 1;
      background: ${T.inputBg};
      border: 1px solid ${T.inputBorder};
      border-radius: 10px;
      padding: 9px 13px;
      font-size: 13.5px;
      color: ${T.text};
      outline: none;
      resize: none;
      font-family: inherit;
      line-height: 1.45;
      max-height: 80px;
      overflow-y: auto;
      transition: border-color 0.2s;
    }
    #vea-input::placeholder { color: ${T.muted}; }
    #vea-input:focus { border-color: rgba(200,184,154,0.35); }

    #vea-send {
      width: 36px;
      height: 36px;
      border-radius: 9px;
      background: ${T.accent};
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.15s, transform 0.15s;
    }
    #vea-send:hover  { opacity: 0.85; }
    #vea-send:active { transform: scale(0.93); }
    #vea-send svg    { fill: #0e0e0e; width: 15px; height: 15px; }

    /* ── Branding ── */
    #vea-brand {
      text-align: center;
      font-size: 10px;
      color: ${T.muted};
      padding: 5px 0 9px;
      opacity: 0.5;
      flex-shrink: 0;
      font-family: inherit;
    }

    /* ── Mobile full screen ── */
    @media (max-width: 440px) {
      #vea-window {
        right: 0;
        bottom: 0;
        width: 100vw;
        max-width: 100vw;
        height: 100dvh;
        max-height: 100dvh;
        border-radius: 0;
        border: none;
      }
      #vea-fab { bottom: 20px; right: 20px; }
    }
  `;

  /* ─────────────────────────────────────────
     SVG ICONS
  ───────────────────────────────────────── */
  // Diamond/rhombus mark for VEA (used in chat header & avatars)
  const ICON_VEA = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L22 12L12 22L2 12L12 2Z"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
  const ICON_USER = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
  // Chat bubble with three-dot cutouts — used on the FAB button
  const ICON_CHAT = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 2h18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-9.5L6 22v-4H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4.5 9a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm4 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm4 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z"/></svg>`;

  /* ─────────────────────────────────────────
     BUILD DOM
  ───────────────────────────────────────── */
  function buildWidget() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // FAB
    const fab = document.createElement("button");
    fab.id = "vea-fab";
    fab.setAttribute("aria-label", "Chat with Virtually Ever After");
    fab.innerHTML = `
      <span id="vea-fab-icon">${ICON_CHAT}</span>
      <span id="vea-badge"></span>
    `;
    fab.querySelector("#vea-fab-icon svg").style.cssText =
      `width:22px;height:22px;color:${T.fabColor}`;

    // Window
    const win = document.createElement("div");
    win.id = "vea-window";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", "Virtually Ever After chat");
    win.classList.add("vea-closed");
    win.innerHTML = `
      <div id="vea-header">
        <div id="vea-header-mark">${ICON_VEA}</div>
        <div id="vea-header-info">
          <div id="vea-header-name">Vera · Virtually Ever After</div>
          <div id="vea-header-sub">
            <span class="vea-dot"></span>
            <span>Online</span>
          </div>
        </div>
        <button id="vea-close" aria-label="Close">✕</button>
      </div>
      <div id="vea-msgs" role="log" aria-live="polite"></div>
      <div id="vea-qr"></div>
      <div id="vea-input-area">
        <textarea id="vea-input" placeholder="Ask anything…" rows="1" aria-label="Message"></textarea>
        <button id="vea-send" aria-label="Send">${ICON_SEND}</button>
      </div>
      <div id="vea-brand">Virtually Ever After · virtuallyeverafter.xyz</div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(win);

    return {
      fab,
      badge:   fab.querySelector("#vea-badge"),
      win,
      msgs:    win.querySelector("#vea-msgs"),
      qr:      win.querySelector("#vea-qr"),
      input:   win.querySelector("#vea-input"),
      send:    win.querySelector("#vea-send"),
      close:   win.querySelector("#vea-close"),
    };
  }

  /* ─────────────────────────────────────────
     MESSAGE HELPERS
  ───────────────────────────────────────── */
  function appendMsg(container, role, html) {
    const isBot = role === "bot";
    const row   = document.createElement("div");
    row.className = `vea-row vea-${role}`;

    const avatar = document.createElement("div");
    avatar.className = `vea-avatar ${isBot ? "" : "vea-avatar-user"}`;
    avatar.innerHTML = isBot ? ICON_VEA : ICON_USER;

    const bubble = document.createElement("div");
    bubble.className = "vea-bubble";
    bubble.innerHTML = html;

    if (isBot) {
      row.appendChild(avatar);
      row.appendChild(bubble);
    } else {
      row.appendChild(bubble);
      row.appendChild(avatar);
    }

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  function showTyping(container) {
    const row = document.createElement("div");
    row.className = "vea-row vea-bot";
    const avatar = document.createElement("div");
    avatar.className = "vea-avatar";
    avatar.innerHTML = ICON_VEA;
    const bubble = document.createElement("div");
    bubble.className = "vea-bubble";
    bubble.innerHTML = `<div class="vea-typing"><span></span><span></span><span></span></div>`;
    row.appendChild(avatar);
    row.appendChild(bubble);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  function setQuickReplies(qrEl, replies, handler) {
    qrEl.innerHTML = "";
    for (const r of replies) {
      const btn = document.createElement("button");
      btn.className = "vea-qr-btn";
      btn.textContent = r;
      btn.addEventListener("click", () => handler(r));
      qrEl.appendChild(btn);
    }
  }

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */
  function init() {
    const ui    = buildWidget();
    let isOpen  = false;
    let greeted = false;

    /* ── Open / close ── */
    function open() {
      isOpen = true;
      ui.win.classList.remove("vea-closed");
      ui.badge.style.display = "none";
      ui.fab.querySelector("#vea-fab-icon").innerHTML =
        `<svg viewBox="0 0 24 24" width="18" height="18" style="fill:${T.fabColor}"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
      ui.input.focus();

      if (!greeted) {
        greeted = true;
        const delay = setTimeout(() => {
          const t = showTyping(ui.msgs);
          setTimeout(() => {
            t.remove();
            appendMsg(ui.msgs, "bot", mdToHtml(CFG.greeting));
            setQuickReplies(ui.qr, [
              "What is VEA?",
              "What services do you offer?",
              "Show me your work",
              "Who founded VEA?",
            ], handleSend);
          }, 800);
        }, 150);
      }
    }

    function close() {
      isOpen = false;
      ui.win.classList.add("vea-closed");
      ui.fab.querySelector("#vea-fab-icon").innerHTML = ICON_CHAT;
      ui.fab.querySelector("#vea-fab-icon svg").style.cssText =
        `width:22px;height:22px;color:${T.fabColor}`;
    }

    /* ── Handle a user message ── */
    function handleSend(text) {
      text = (text || ui.input.value).trim();
      if (!text) return;

      ui.qr.innerHTML = "";
      appendMsg(ui.msgs, "user", escapeHtml(text));
      ui.input.value = "";
      ui.input.style.height = "auto";

      const typing = showTyping(ui.msgs);
      const delay  = 500 + Math.random() * 600;

      setTimeout(() => {
        typing.remove();
        const entry  = findBestEntry(text);
        const reply  = entry
          ? entry.reply
          : `That's a thoughtful question. For the most accurate answer, reach out directly to the team:\n\n📧 **hello@virtuallyeverafter.xyz**\n\nOr ask me something else — I'm happy to tell you more about VEA's work and services.`;
        const nextQR = entry && entry.next && entry.next.length > 0
          ? entry.next
          : ["What services do you offer?", "Show me your work", "How do we start?"];

        appendMsg(ui.msgs, "bot", mdToHtml(reply));
        setQuickReplies(ui.qr, nextQR, handleSend);
      }, delay);
    }

    /* ── Events ── */
    ui.fab.addEventListener("click",   () => isOpen ? close() : open());
    ui.close.addEventListener("click", close);
    ui.send.addEventListener("click",  () => handleSend());

    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    ui.input.addEventListener("input", () => {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, 80) + "px";
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) close();
    });
  }

  /* ─────────────────────────────────────────
     BOOT
  ───────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
