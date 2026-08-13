/**
 * Renders every Eliza Research Reflow-study route from one verified content
 * source. Edition selection changes composition only; navigation, contact
 * behavior, product truth, and accessibility remain identical across cuts.
 */
(() => {
  const email = "hello@elizaresearch.ai";
  const routeFiles = {
    home: "reflow",
    about: "reflow-about",
    team: "reflow-team",
    contact: "reflow-contact",
    animation: "reflow-animation",
    privacy: "reflow-privacy",
    terms: "reflow-terms",
  };
  const pageNames = {
    home: "Home",
    about: "About",
    team: "Team",
    contact: "Contact",
    animation: "Particle study",
    privacy: "Privacy",
    terms: "Terms",
  };
  const editions = {
    rail: {
      label: "Reflow / Black",
      description:
        "The literal control: black field, fixed rail, edge email, and the particle mark as the whole room.",
    },
    field: {
      label: "Shaw / Orange",
      description:
        "The brand-first cut: Shaw orange fills the stage while the white mark and dark type trade focus.",
    },
    index: {
      label: "Research / Paper",
      description:
        "The clearest company cut: paper, ink, and orange arranged as a typographic research index.",
    },
  };
  const body = document.body;
  const page = body.dataset.reflowPage;
  const requestedEdition = new URLSearchParams(location.search).get("edition");
  const edition = Object.hasOwn(editions, requestedEdition)
    ? requestedEdition
    : "rail";
  const app = document.getElementById("reflow-app");
  if (!app) throw new Error("Reflow study mount is unavailable");

  function routeHref(route, targetEdition = edition) {
    return `${routeFiles[route]}?edition=${targetEdition}`;
  }

  function navLink(route) {
    const current = page === route ? ' aria-current="page"' : "";
    return `<a href="${routeHref(route)}"${current}>${pageNames[route].toUpperCase()}</a>`;
  }

  function socialLinks() {
    return `<a href="https://x.com/elizaOS" aria-label="Eliza Research on X">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
    </a>
    <a href="https://github.com/elizaOS" aria-label="elizaOS on GitHub">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.302 24 12 24 5.373 18.627 0 12 0z"></path></svg>
    </a>`;
  }

  function workIndex() {
    return `<div class="work-index" aria-label="Products">
      <a href="https://github.com/elizaOS/eliza">
        <strong>Eliza</strong>
        <span>Your personal superagent—and an open source operating system.</span>
        <b aria-hidden="true">↗</b>
      </a>
      <a href="https://slop.cash">
        <strong>slop.cash</strong>
        <span>A swarm contribution platform.</span>
        <b aria-hidden="true">↗</b>
      </a>
    </div>`;
  }

  function pageContent() {
    if (page === "home") {
      return `<section class="home-copy">
        <p class="home-thesis">AI, built around people.</p>
        <h1>Eliza Research</h1>
        <p class="lead">Eliza Research builds products at the intersection of artificial intelligence and the people who live with it.</p>
        <a class="text-action" href="${routeHref("about")}">Enter the work <span aria-hidden="true">→</span></a>
      </section>`;
    }
    if (page === "about") {
      return `<section class="copy-page">
        <h1>About</h1>
        <p class="lead">Eliza Research builds products at the intersection of artificial intelligence and the people who live with it.</p>
        <p class="thesis">Intelligence is getting cheap. <strong>Agency</strong> is the scarce thing—software that acts for you, answers to you, and belongs to everyone.</p>
        ${workIndex()}
      </section>`;
    }
    if (page === "team") {
      return `<section class="copy-page team-page">
        <h1>Team</h1>
        <p class="lead">We are a small team building in the open.</p>
        <p class="thesis">If that sounds like you, work on this with us.</p>
        <div class="action-row">
          <a class="text-action" href="mailto:${email}">Write to us <span aria-hidden="true">→</span></a>
          <a class="text-action" href="https://github.com/elizaOS">Build with us on GitHub <span aria-hidden="true">↗</span></a>
        </div>
        <p class="truth-note">Individual team profiles have not been published for this preview.</p>
      </section>`;
    }
    if (page === "contact") {
      return `<section class="copy-page contact-page">
        <h1>Work on this with us.</h1>
        <p class="lead">We are a small team building in the open. If that sounds like you, write to us.</p>
        <button class="email-display" type="button" data-copy-email aria-label="Copy ${email}">${email}</button>
        <div class="action-row">
          <a class="text-action" href="https://github.com/elizaOS">GitHub <span aria-hidden="true">↗</span></a>
          <a class="text-action" href="https://x.com/elizaOS">X <span aria-hidden="true">↗</span></a>
        </div>
      </section>`;
    }
    if (page === "animation") {
      return `<section class="copy-page animation-page">
        <h1>Particle study</h1>
        <p class="lead">The Eliza mark forms from grouped dots, then stays quietly alive.</p>
        <p class="thesis">Move through the face to bend the field. Press to deepen the motion. The cursor core stays filled and every dot returns.</p>
        <p class="truth-note">Local motion specimen · excluded from production navigation.</p>
      </section>`;
    }
    if (page === "privacy") {
      return `<section class="copy-page legal-page">
        <h1>Privacy</h1>
        <p class="lead">A privacy policy has not been published for this preview.</p>
        <p class="thesis">No policy text is presented here. Questions can be sent directly to <a href="mailto:${email}">${email}</a>.</p>
      </section>`;
    }
    if (page === "terms") {
      return `<section class="copy-page legal-page">
        <h1>Terms</h1>
        <p class="lead">Terms of service have not been published for this preview.</p>
        <p class="thesis">No terms are presented here. Questions can be sent directly to <a href="mailto:${email}">${email}</a>.</p>
      </section>`;
    }
    throw new Error(`Unknown Reflow study page: ${page}`);
  }

  function renderComparison() {
    document.title = "Choose a Reflow cut — Eliza Research";
    app.innerHTML = `<main class="review-page">
      <header class="review-intro">
        <a class="review-brand" href="/" aria-label="Eliza Research home"><img src="assets/logo_orange_nobg.svg" alt="">Eliza Research</a>
        <h1>Three complete cuts.</h1>
        <p>Each edition includes Home, About, Team, Contact, the particle study, and transparent legal placeholders. Open one and use its own navigation.</p>
      </header>
      <div class="review-grid">
        ${Object.entries(editions)
          .map(
            ([
              key,
              candidate,
            ]) => `<article class="review-card review-card--${key}">
              <div class="review-preview" aria-hidden="true">
                <span class="review-preview-rail"></span>
                <img src="assets/${key === "index" ? "logo_orange_nobg.svg" : "logo_white_nobg.svg"}" alt="">
                <b>Eliza<br>Research</b>
              </div>
              <h2>${candidate.label}</h2>
              <p>${candidate.description}</p>
              <a class="open-cut" href="${routeHref("home", key)}">Open complete cut <span aria-hidden="true">→</span></a>
              <nav aria-label="${candidate.label} pages">
                ${Object.keys(routeFiles)
                  .map(
                    (route) =>
                      `<a href="${routeHref(route, key)}">${pageNames[route]}</a>`,
                  )
                  .join("")}
              </nav>
            </article>`,
          )
          .join("")}
      </div>
      <p class="review-note">These are local studies. No cut is wired into deployment.</p>
    </main>`;
  }

  if (page === "compare") {
    renderComparison();
    return;
  }

  if (!Object.hasOwn(routeFiles, page))
    throw new Error(`Unknown Reflow study route: ${page}`);

  document.title = `${pageNames[page]} — Eliza Research · ${editions[edition].label}`;
  body.dataset.edition = edition;
  const homeCurrent = page === "home" ? ' aria-current="page"' : "";
  app.innerHTML = `<div class="site-shell" data-edition="${edition}" data-page="${page}">
    <a class="skip-link" href="#main-content">Skip to content</a>
    <aside class="site-rail" aria-label="Primary navigation">
      <a class="rail-logo" href="${routeHref("home")}" aria-label="Eliza Research home"${homeCurrent}><img src="assets/logo_orange_nobg.svg" alt=""></a>
      <nav class="rail-nav" aria-label="Desktop navigation">
        ${navLink("about")}${navLink("team")}${navLink("contact")}
      </nav>
      <div class="rail-bottom">
        <div class="social-links">${socialLinks()}</div>
        <a class="review-link" href="reflow-compare">Compare cuts</a>
      </div>
    </aside>
    <header class="mobile-bar">
      <a href="${routeHref("home")}" aria-label="Eliza Research home"${homeCurrent}><img src="assets/logo_orange_nobg.svg" alt=""></a>
      <nav aria-label="Mobile navigation">${navLink("about")}${navLink("team")}${navLink("contact")}</nav>
      <div class="mobile-socials">${socialLinks()}</div>
    </header>
    <div class="site-stage">
      <canvas class="particle-logo" data-particle-logo="assets/logo_white_nobg.svg" aria-hidden="true"></canvas>
      <main class="page-content" id="main-content">${pageContent()}</main>
      <button class="contact-chip" type="button" data-copy-email aria-label="Copy ${email}">${email.toUpperCase()}</button>
      <span class="copy-status" role="status" aria-live="polite"></span>
      <footer class="study-footer">
        <span>© 2026 Eliza Research</span>
        <nav aria-label="Study pages">
          <a href="${routeHref("animation")}">Particle study</a>
          <a href="${routeHref("privacy")}">Privacy</a>
          <a href="${routeHref("terms")}">Terms</a>
        </nav>
      </footer>
    </div>
  </div>`;

  let copyFailed = false;
  let resetTimer = 0;
  const copyButtons = document.querySelectorAll("[data-copy-email]");
  const copyStatus = document.querySelector(".copy-status");
  for (const button of copyButtons) {
    button.addEventListener("click", async () => {
      if (copyFailed) {
        location.href = `mailto:${email}`;
        return;
      }
      try {
        await navigator.clipboard.writeText(email);
        clearTimeout(resetTimer);
        for (const peer of copyButtons) {
          peer.dataset.feedback = "success";
          peer.textContent = "COPIED!";
          peer.setAttribute("aria-label", `${email} copied`);
        }
        copyStatus.textContent = `${email} copied to clipboard.`;
        resetTimer = setTimeout(() => {
          for (const peer of copyButtons) {
            delete peer.dataset.feedback;
            peer.textContent = peer.classList.contains("contact-chip")
              ? email.toUpperCase()
              : email;
            peer.setAttribute("aria-label", `Copy ${email}`);
          }
          copyStatus.textContent = "";
        }, 1800);
      } catch {
        // error-policy:J4 Clipboard denial becomes an explicit mail action.
        copyFailed = true;
        for (const peer of copyButtons) {
          peer.dataset.feedback = "error";
          peer.textContent = "COPY FAILED · OPEN EMAIL";
          peer.setAttribute(
            "aria-label",
            `Copy failed. Open an email to ${email}`,
          );
        }
        copyStatus.textContent = `Copy failed. Activate again to email ${email}.`;
      }
    });
  }
})();
