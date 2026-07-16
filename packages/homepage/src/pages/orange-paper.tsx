/**
 * Orange Paper route ported from the sovereign elizaOS static page.
 */
import { type ReactNode, useEffect } from "react";

const MARK = "/brand/logos/logo_orange_nobg.svg";

export default function OrangePaperPage() {
  useEffect(() => {
    const title = "elizaOS: the Orange Paper";
    const description =
      "Bitcoin gave you sovereign money. elizaOS gives you a sovereign mind.";
    document.title = title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", description);
    document
      .querySelector('meta[property="og:title"]')
      ?.setAttribute("content", title);
    document
      .querySelector('meta[property="og:description"]')
      ?.setAttribute("content", description);
  }, []);

  return (
    <div className="orange-paper">
      <a href="#paper-main" className="sovereign-skip">
        Skip to content
      </a>
      <div className="orange-content">
        <nav className="orange-top" aria-label="Orange Paper">
          <div className="orange-top-wrap">
            <a className="orange-brand" href="/">
              <img src={MARK} alt="" draggable={false} />
              <span>elizaOS</span>
            </a>
            <a className="orange-back" href="/">
              ← back
            </a>
          </div>
        </nav>

        <header className="orange-mast">
          <div className="orange-wide">
            <div className="orange-kick">The Orange Paper · v1 · 2026</div>
            <h1>
              Own your
              <br />
              intelligence.
            </h1>
            <p className="orange-dek">
              Bitcoin gave you sovereign money. elizaOS gives you a sovereign
              mind. The case for why the agent that runs your life has to be
              open, private, and yours.
            </p>
            <p className="orange-byline">
              elizaOS · open source · cypherpunk · orange-pilled · agent-native
            </p>
          </div>
        </header>

        <main id="paper-main">
          <article className="orange-article">
            <div className="orange-wrap">
              <p className="orange-lead">
                For thirty years we have carried computers that work{" "}
                <em>against</em> us. They watch, they harvest, they optimize for
                our attention because our attention is the product. The last
                decade made it worse: the smartphone became the most
                sophisticated attention-extraction machine ever built, and we
                call it a personal device. It was never personal. It answered to
                someone else.
              </p>

              <p>
                AI changes the terms. For the first time, software can not just
                show you things, it can <em>do</em> things: run your errands,
                hold your context, chase the follow-ups, manage the thousand
                small administrative weights that eat a life. This is the
                biggest shift since the OS itself. And it is about to be
                captured.
              </p>
              <p>
                The same companies whose business model is surveillance are
                racing to own the agent layer. If they win, the most intimate
                software you will ever run, the thing that knows your calendar,
                your messages, your money, your mind, will answer to a
                shareholder, not to you.{" "}
                <strong>That is the whole fight.</strong> Whoever owns the agent
                OS owns the person.
              </p>

              <blockquote>
                The agent that runs your life should belong to you. Fully. Its
                source open, its data yours, its loyalty singular.
                <span>the elizaOS premise</span>
              </blockquote>

              <PaperSection
                number="01 / THE ETHOS"
                title="Cypherpunk, not by aesthetic, by architecture."
              >
                <p>
                  In 1993 Eric Hughes wrote,{" "}
                  <em>
                    "privacy is necessary for an open society in the electronic
                    age."
                  </em>{" "}
                  The cypherpunks understood something the industry spent thirty
                  years forgetting: freedom in a digital world is not granted by
                  policy, it is <strong>enforced by architecture.</strong> You
                  do not ask a platform to respect you. You build systems that
                  cannot betray you.
                </p>
                <p>
                  Bitcoin orange-pilled a generation on sovereign <em>money</em>
                  , the radical idea that you could hold value no institution
                  could freeze, debase, or take. This is the same pill, one
                  layer up. <strong>Sovereign intelligence.</strong> An agent
                  that holds your context, your memory, your leverage, that no
                  platform can freeze, harvest, or turn against you. First we
                  took back the money. Now we take back the mind.
                </p>
                <p>
                  elizaOS is that principle applied to the agent era. Open
                  source so it can be audited, not trusted. Self-hostable so
                  your data never has to leave your machine. No telemetry, not
                  as a setting, as a design. Your keys, your data, your agent,
                  your machine.{" "}
                  <strong>
                    Open is the only architecture that stays honest.
                  </strong>
                </p>
              </PaperSection>

              <PaperSection
                number="02 / THE MISTAKE EVERYONE MADE"
                title="They built gadgets. The layer is an OS."
              >
                <p>
                  The last two years produced a graveyard. Rabbit R1: mass
                  returns, missed payroll. Humane's Pin: returns outpaced sales,
                  the devices bricked. Meta absorbed Limitless. Amazon absorbed
                  Bee. Every one of them made the same error, they built a{" "}
                  <em>device</em> that tried to replace the phone, and asked
                  people to carry one more thing that did less.
                </p>
                <p>
                  The lesson is not "AI hardware is doomed." The lesson is that{" "}
                  <strong>
                    the value was never in the gadget. It was in the layer
                    underneath.
                  </strong>{" "}
                  An agent is not a product you hold. It is an operating system,
                  persistent, present across everything you own,
                  form-factor-agnostic by design.
                </p>
                <p className="orange-statline">
                  Hardware is the wedge. The OS, the community, and the cloud
                  are the moat.
                </p>
              </PaperSection>

              <PaperSection
                number="03 / THE PARALLELS"
                title="This has happened before. It rhymes."
              >
                <p>
                  Every great open platform followed the same arc: a free,
                  auditable core that becomes infrastructure, and a commercial
                  layer that funds it without ever closing it. We are not
                  inventing a business model. We are applying a proven one to
                  the agent era.
                </p>
                <div className="orange-parallels">
                  {[
                    [
                      "Linux",
                      "the pattern",
                      "An open kernel nobody could own became the substrate of the entire internet. It didn't win by being proprietary. It won by being everywhere, and impossible to capture. elizaOS is the kernel for agents.",
                    ],
                    [
                      "Red Hat",
                      "the economics",
                      "Proved you make serious money on open source without closing it: support, hardening, and cloud for the organizations that need it. RHEL runs a >$6.5B business on a free core. That is our enterprise arm.",
                    ],
                    [
                      "The cypherpunks",
                      "the ethos",
                      "Privacy and agency for the individual, enforced in software, not begged for in policy. PGP, Tor, Bitcoin, Signal. elizaOS is the same lineage, pointed at the agent that runs your life.",
                    ],
                    [
                      "The smartphone",
                      "the anti-pattern",
                      "The device that promised to serve you and learned to farm you. We are building its opposite: software designed to give your time back, not to consume it. The anti-attention machine.",
                    ],
                  ].map(([who, small, what]) => (
                    <div className="orange-par" key={who}>
                      <div>
                        {who}
                        <small>{small}</small>
                      </div>
                      <p>{what}</p>
                    </div>
                  ))}
                </div>
              </PaperSection>

              <PaperSection
                number="04 / WHERE WE WIN FIRST"
                title="Start where the giants structurally cannot follow."
              >
                <p>
                  Apple and Google cannot credibly ship a private, no-telemetry,
                  sovereign device, because telemetry <em>is</em> their business
                  model. That single fact is the wedge. The first market for an
                  open, auditable, no-tracking agent OS is exactly the market
                  the incumbents are locked out of:
                </p>
                <ul>
                  <li>
                    <strong>Sovereign and regulated devices.</strong> Private
                    phones for government and enterprise, where an open,
                    no-surveillance base is not a preference but a procurement
                    requirement.
                  </li>
                  <li>
                    <strong>The overwhelmed and the neurodivergent.</strong>{" "}
                    Tens of millions of people whose lives are genuinely hard to
                    manage, an agent that carries the executive-function load.
                  </li>
                  <li>
                    <strong>The builders.</strong> An open-source community
                    already tens of thousands strong. The distribution engine,
                    the contributors, the proof.
                  </li>
                </ul>
                <p>
                  Win the wedge where openness is the requirement. Then widen to
                  every device, because the same OS runs everywhere.
                </p>
              </PaperSection>

              <PaperSection
                number="05 / HOW IT STAYS HONEST"
                title="A structure that can't be sold out."
              >
                <p>
                  Open-source promises die when a cap table changes its mind.
                  We've watched it happen. So the openness isn't a pledge, it's
                  a structure:{" "}
                  <strong>
                    a foundation that holds the mission and the license, and a
                    company that builds the products.
                  </strong>
                </p>
                <p>
                  The foundation owns the core and the mark, mission-locked, so
                  the software cannot be closed, no matter who invests or who is
                  in the room. The company employs the builders, runs the cloud,
                  serves the enterprise, and raises the capital to move fast.
                </p>
              </PaperSection>

              <PaperSection
                number="06 / THE ARC"
                title="The Linux of agent devices."
              >
                <p>
                  <strong>Land the sovereign wedge</strong>, the devices where
                  open is non-negotiable. <strong>Widen to every device</strong>
                  , the same agent, your data, everywhere, carried by the
                  community and monetized by the cloud.{" "}
                  <strong>Own the layer</strong>, become the default operating
                  system of the agent era.
                </p>
                <p>
                  And beyond the OS: our own open models. If intelligence itself
                  is the thing every person deserves access to, then the models
                  can't only belong to a handful of closed labs either.
                </p>
              </PaperSection>

              <blockquote>
                We play to win. But we win by giving people agency, not by
                taking their attention.
              </blockquote>
            </div>
          </article>

          <footer className="orange-end">
            <div className="orange-wrap">
              <img src={MARK} alt="elizaOS" />
              <p className="orange-creed">
                Get orange-pilled on your own mind.
              </p>
              <p className="orange-subcreed">
                Sovereign money → sovereign intelligence
              </p>
              <div className="orange-cta">
                <a
                  className="orange-btn primary"
                  href="https://github.com/elizaOS/eliza"
                >
                  github.com/elizaOS
                </a>
                <a className="orange-btn" href="/">
                  Back to the site
                </a>
              </div>
              <p className="orange-colophon">
                elizaOS · open-source agent operating system · foundation + PBC
                · privacy is necessary for an open society in the electronic age
              </p>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function PaperSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2>
        <span>{number}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
