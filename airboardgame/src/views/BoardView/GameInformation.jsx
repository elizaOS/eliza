import React from "react";
import { useTranslation } from "react-i18next";
import useAsyncEffect from "use-async-effect";
import { useBoardConfig } from "react-sync-board";

import { getBestTranslationFromConfig } from "../../utils/api";

const GameInformation = () => {
  const { t, i18n } = useTranslation();

  const [info, setInfo] = React.useState("");

  const [boardConfig] = useBoardConfig();

  const translation = React.useMemo(
    () => getBestTranslationFromConfig(boardConfig, i18n.languages),
    [boardConfig, i18n.languages]
  );

  useAsyncEffect(
    async (isMounted) => {
      const { marked } = await import("marked");
      if (!isMounted()) return;

      const renderer = new marked.Renderer();
      renderer.link = (href, title, text) => {
        return `<a target="_blank" rel="noopener" href="${href}" title="${title}">${text}</a>`;
      };
      setInfo(
        marked.parse(translation.description || "", {
          renderer: renderer,
        })
      );
    },
    [setInfo, translation.description]
  );

  return (
    <>
      <header>
        <h3>{t("Game information")}</h3>
      </header>
      <section>
        {translation.description && (
          <div
            dangerouslySetInnerHTML={{
              __html: info,
            }}
          ></div>
        )}
        {!translation.description && <div>{t("No information")}</div>}
      </section>
    </>
  );
};

export default GameInformation;
