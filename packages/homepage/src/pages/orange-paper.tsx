/** The public Orange Paper, kept separate from the product homepage. */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

export default function OrangePaperPage() {
  const t = useT();
  const p = (name: string, defaultValue: string) =>
    t(`homepage_eliza.orangePaper.${name}`, { defaultValue });
  return (
    <div className="paper-site">
      <a className="life-skip" href="#paper-main">
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="paper-nav">
        <a
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
        >
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
          />
        </a>
        <span>{p("edition", "Public edition · 2026")}</span>
        <a href="/">
          <ArrowLeft aria-hidden="true" />
          {p("back", "Back to eliza.app")}
        </a>
      </header>
      <main id="paper-main">
        <header className="paper-mast">
          <p>{p("kicker", "The Orange Paper · v1")}</p>
          <h1>{p("title", "Own your intelligence.")}</h1>
          <p className="paper-dek">
            {p(
              "dek",
              "Bitcoin gave you sovereign money. elizaOS gives you a sovereign mind. The case for why the agent that runs your life has to be open, private, and yours.",
            )}
          </p>
          <p className="paper-language">
            {p(
              "languageNote",
              "This first public edition is available in English.",
            )}
          </p>
        </header>
        <article className="paper-body">
          <p className="paper-lead">
            {p(
              "lead",
              "For thirty years we have carried computers that work against us. They watch, harvest, and optimize for our attention because our attention is the product. The smartphone became the most sophisticated attention-extraction machine ever built, and we call it personal. It was never personal. It answered to someone else.",
            )}
          </p>
          <p>
            {p(
              "introTwo",
              "AI changes the terms. For the first time, software can not just show you things, it can do things: run errands, hold context, chase follow-ups, and carry the thousand administrative weights that eat a life. This is the biggest shift since the operating system itself. And it is about to be captured.",
            )}
          </p>
          <p>
            {p(
              "introThree",
              "The same companies whose business model is surveillance are racing to own the agent layer. If they win, the most intimate software you will ever run will answer to a shareholder, not to you. Whoever owns the agent OS owns the person.",
            )}
          </p>
          <blockquote>
            {p(
              "premise",
              "The agent that runs your life should belong to you. Fully. Its source open, its data yours, its loyalty singular.",
            )}
            <cite>{p("premiseCite", "The elizaOS premise")}</cite>
          </blockquote>

          <PaperSection
            number="01"
            label={p("ethosLabel", "The ethos")}
            title={p(
              "ethosTitle",
              "Cypherpunk by architecture, not aesthetic.",
            )}
          >
            <p>
              {p(
                "ethosOne",
                "In 1993 Eric Hughes wrote that privacy is necessary for an open society in the electronic age. The cypherpunks understood something the industry spent thirty years forgetting: freedom in a digital world is not granted by policy. It is enforced by architecture. You do not ask a platform to respect you. You build systems that cannot betray you.",
              )}
            </p>
            <p>
              {p(
                "ethosTwo",
                "Bitcoin made sovereign money real, value no institution could freeze, debase, or take. This is the same principle one layer up: sovereign intelligence. An agent that holds your context, memory, and leverage, and that no platform can harvest or turn against you.",
              )}
            </p>
            <p>
              {p(
                "ethosThree",
                "elizaOS applies that principle to the agent era. Open source so it can be audited, not trusted. Self-hostable so your data never has to leave your machine. No telemetry as a design, not a setting. Open is the only architecture that stays honest.",
              )}
            </p>
          </PaperSection>

          <PaperSection
            number="02"
            label={p("layerLabel", "The layer")}
            title={p("layerTitle", "They built gadgets. The layer is an OS.")}
          >
            <p>
              {p(
                "layerOne",
                "The first wave produced a gadget graveyard. Each product made the same error: it built a device that tried to replace the phone and asked people to carry one more thing that did less.",
              )}
            </p>
            <p>
              {p(
                "layerTwo",
                "The lesson is not that AI hardware is doomed. The value was never in the gadget. It was in the layer underneath. An agent is an operating system, persistent across everything you own and independent of form factor: phone, desktop, a USB key, a small computer, a home device, a robot, or glasses when they matter.",
              )}
            </p>
            <aside>
              {p(
                "layerAside",
                "Hardware can be the wedge. The OS, the community, and the cloud are the moat.",
              )}
            </aside>
          </PaperSection>

          <PaperSection
            number="03"
            label={p("patternLabel", "The pattern")}
            title={p("patternTitle", "This has happened before. It rhymes.")}
          >
            <p>
              {p(
                "patternIntro",
                "Great open platforms follow a durable arc: a free, auditable core becomes infrastructure, while a commercial layer funds it without closing it.",
              )}
            </p>
            <dl className="paper-patterns">
              <div>
                <dt>{p("linux", "Linux")}</dt>
                <dd>
                  {p(
                    "linuxPattern",
                    "An open kernel nobody could own became the substrate of the internet. It won by being everywhere and impossible to capture. elizaOS is the kernel for agents.",
                  )}
                </dd>
              </div>
              <div>
                <dt>{p("redHat", "Red Hat")}</dt>
                <dd>
                  {p(
                    "redHatPattern",
                    "Open source can support a serious business through hosting, hardening, support, and the services organizations need.",
                  )}
                </dd>
              </div>
              <div>
                <dt>{p("cypherpunks", "Cypherpunks")}</dt>
                <dd>
                  {p(
                    "cypherPattern",
                    "Privacy and agency for the individual, enforced in software rather than begged for in policy.",
                  )}
                </dd>
              </div>
              <div>
                <dt>{p("smartphone", "The smartphone")}</dt>
                <dd>
                  {p(
                    "phonePattern",
                    "The anti-pattern: a device that promised to serve you and learned to farm you. We are building software that gives time back.",
                  )}
                </dd>
              </div>
            </dl>
          </PaperSection>

          <PaperSection
            number="04"
            label={p("designLabel", "The design")}
            title={p(
              "designTitle",
              "One agent. Every device. Your data stays yours.",
            )}
          >
            <p>
              {p(
                "designOne",
                "The companion app is the interface on devices you already carry. The elizaOS runtime holds identity, memory, tools, and permissions. It can run locally, self-hosted, or in hosted cloud when convenience matters. The interface changes. The agent does not.",
              )}
            </p>
            <ul>
              <li>
                {p(
                  "designLocal",
                  "Local-first, so control starts with the person.",
                )}
              </li>
              <li>
                {p(
                  "designPortable",
                  "Portable state, so switching a surface does not mean starting over.",
                )}
              </li>
              <li>
                {p(
                  "designPermission",
                  "Permissioned action, so autonomy stays accountable.",
                )}
              </li>
              <li>
                {p(
                  "designCloud",
                  "Cloud optional, so convenience never becomes captivity.",
                )}
              </li>
            </ul>
          </PaperSection>

          <PaperSection
            number="05"
            label={p("wedgeLabel", "Where open wins")}
            title={p("wedgeTitle", "Start where the giants cannot follow.")}
          >
            <p>
              {p(
                "wedgeOne",
                "Surveillance businesses cannot credibly offer a no-telemetry agent. That creates a natural first market wherever auditability, privacy, portability, and user control are requirements rather than preferences.",
              )}
            </p>
            <p>
              {p(
                "wedgeTwo",
                "From there, the same architecture widens to every person and device. Builders get an open foundation. People with too much to carry get relief without surrendering their private lives. Organizations get software they can inspect and operate on their own terms.",
              )}
            </p>
          </PaperSection>

          <PaperSection
            number="06"
            label={p("arcLabel", "The arc")}
            title={p("arcTitle", "The Linux of agents.")}
          >
            <p>
              {p(
                "arcOne",
                "Land where openness is non-negotiable. Widen across devices through the community. Become the trusted open base for the agent era. Open core forever, with hosted cloud and support for people and organizations that want them.",
              )}
            </p>
            <p>
              {p(
                "arcTwo",
                "And beyond the runtime: open models. If intelligence is something every person deserves access to, the models cannot belong only to a handful of closed labs. The same principle goes all the way down.",
              )}
            </p>
          </PaperSection>
          <blockquote>
            {p(
              "closingQuote",
              "We play to win. But we win by giving people agency, not by taking their attention.",
            )}
          </blockquote>
        </article>
        <section className="paper-end">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.markOrangeNoBg}`}
            alt=""
          />
          <h2>{p("endTitle", "Get orange-pilled on your own mind.")}</h2>
          <p>{p("endLine", "Sovereign money → sovereign intelligence")}</p>
          <div>
            <a href={EXTERNAL_URLS.github}>
              {p("github", "Build with us")}
              <ArrowRight aria-hidden="true" />
            </a>
            <a href="/">{p("backSite", "Back to eliza.app")}</a>
          </div>
        </section>
      </main>
    </div>
  );
}

function PaperSection({
  number,
  label,
  title,
  children,
}: {
  number: string;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  const id = `paper-${number}`;
  return (
    <section className="paper-section" aria-labelledby={id}>
      <div className="paper-section-label">
        <span>{number}</span>
        <span>{label}</span>
      </div>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
