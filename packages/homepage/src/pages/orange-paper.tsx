/** Compact public thesis for sovereign intelligence. */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { useT } from "@/providers/I18nProvider";

export default function OrangePaperPage() {
  const t = useT();
  const paper = (name: string, defaultValue: string) =>
    t(`homepage_eliza.orangePaper.${name}`, { defaultValue });

  return (
    <div className="orange-paper">
      <a className="sovereign-skip" href="#paper-main">
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="orange-paper-nav">
        <a href="/" aria-label="elizaOS home">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.osBlack}`}
            alt="elizaOS"
          />
        </a>
        <a href="/">{paper("back", "Back to eliza.app")}</a>
      </header>

      <main id="paper-main">
        <header className="orange-paper-mast">
          <p>{paper("edition", "The Orange Paper · Public edition · 2026")}</p>
          <h1>{paper("title", "Own your intelligence.")}</h1>
          <div className="orange-paper-dek">
            {paper(
              "dek",
              "Bitcoin gave you sovereign money. elizaOS gives you a sovereign mind.",
            )}
          </div>
        </header>

        <article className="orange-paper-body">
          <p className="orange-paper-lead">
            {paper(
              "lead",
              "The agent that knows your life should belong to you. Its source open, its data yours, its loyalty singular.",
            )}
          </p>

          <section aria-labelledby="paper-sovereign">
            <span>
              {paper("sovereignLabel", "01 / Sovereign intelligence")}
            </span>
            <h2 id="paper-sovereign">
              {paper("sovereignTitle", "Control, enforced in software.")}
            </h2>
            <p>
              {paper(
                "sovereignBody",
                "Agents hold context, memory, and leverage. Sovereignty means that layer can be inspected, moved, and run without asking a platform for permission.",
              )}
            </p>
          </section>

          <section aria-labelledby="paper-runtime">
            <span>{paper("runtimeLabel", "02 / One runtime")}</span>
            <h2 id="paper-runtime">
              {paper("runtimeTitle", "Every surface, the same agent.")}
            </h2>
            <p>
              {paper(
                "runtimeBody",
                "Phone, desktop, messages, and edge hardware are interfaces. Identity, memory, tools, and permissions remain with one portable runtime.",
              )}
            </p>
          </section>

          <blockquote>
            {paper("quote", "Your keys. Your data. Your agent. Your machine.")}
          </blockquote>

          <section aria-labelledby="paper-state">
            <span>{paper("stateLabel", "03 / Private state")}</span>
            <h2 id="paper-state">
              {paper("stateTitle", "Persistent without becoming public.")}
            </h2>
            <p>
              {paper(
                "stateBody",
                "Run local, self-hosted, or in a private deployment. Managed cloud is available when convenience matters, but it is not the price of entry.",
              )}
            </p>
          </section>

          <section aria-labelledby="paper-model">
            <span>{paper("modelLabel", "04 / Open core")}</span>
            <h2 id="paper-model">
              {paper("modelTitle", "Open software. Commercial operations.")}
            </h2>
            <p>
              {paper(
                "modelBody",
                "The runtime stays open and self-hostable. Managed persistence, private deployments, enterprise controls, integrations, and support fund the work around it.",
              )}
            </p>
          </section>

          <section aria-labelledby="paper-wedge">
            <span>{paper("wedgeLabel", "05 / Where it starts")}</span>
            <h2 id="paper-wedge">
              {paper("wedgeTitle", "Privacy as a requirement.")}
            </h2>
            <p>
              {paper(
                "wedgeBody",
                "Private agent infrastructure matters first where sensitive context cannot enter a public black box. Regulated teams and enterprises need explicit boundaries for identity, data, policy, and deployment.",
              )}
            </p>
          </section>
        </article>

        <footer className="orange-paper-end">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.markOrangeNoBg}`}
            alt=""
          />
          <h2>
            {paper("endTitle", "Build the layer once. Carry it everywhere.")}
          </h2>
          <div>
            <a href={EXTERNAL_URLS.github}>
              {paper("github", "View on GitHub")} ↗
            </a>
            <a href="/">{paper("back", "Back to eliza.app")}</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
