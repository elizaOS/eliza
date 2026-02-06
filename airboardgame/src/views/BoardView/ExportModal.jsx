import React from "react";
import { useTranslation } from "react-i18next";

import useSession from "../../hooks/useSession";

import DownloadLink from "./DownloadLink";
import Modal from "../../ui/Modal";

const ExportModal = ({ show, setShow }) => {
  const { t } = useTranslation();
  const { getSession } = useSession();
  const [withFile, setWithFile] = React.useState(false);

  return (
    <Modal title={t("Save game")} setShow={setShow} show={show}>
      <header>
        <h3>{t("Want to continue later?")}</h3>
      </header>
      <section>
        <p>
          {t(
            "You can save the current session on your computer to load it later!"
          )}
        </p>
        <DownloadLink getData={getSession} withFile={withFile} />
        <div style={{ paddingTop: "1em" }}>
          <label>
            <input
              type="checkbox"
              checked={withFile}
              onChange={() => setWithFile((prev) => !prev)}
            />
            {t("Include files")}
          </label>
        </div>
      </section>
    </Modal>
  );
};

export default ExportModal;
