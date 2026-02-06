import React from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";

import Modal from "../ui/Modal";

const AboutModal = ({ show, setShow }) => {
  const { t } = useTranslation();

  return (
    <Modal
      title={t("About")}
      setShow={setShow}
      show={show}
      footer={
        <div style={{ display: "flex", justifyContent: "end" }}>
          <button
            onClick={() => {
              setShow(false);
            }}
            className="button"
          >
            {t("Close")}
          </button>
        </div>
      }
    >
      <Trans i18nKey="about">
        <p>
          Air Board Game is a plateform designed to play any board games with
          your friends online. For more information or to access source code
          visit <a href="https://github.com/jrmi/airboardgame">Github</a>.
        </p>
        <h3>Legal mentions</h3>
        <p>
          This site is hosted by Netlify (San Franscico, US) and OVH (2, rue
          Kellermann, 59100 Roubaix)
        </p>
        <h3>Abuse report</h3>
        <p>
          To report abuse, please email at abu
          <span style={{ display: "none" }}>anti-span</span>
          se-report@airboardgame.com
        </p>
        <h3>RGPD</h3>
        <p>
          No personnal data are collected. When you use your email to login,
          this information is lost and not used for anything else than sending
          you an authentication link.
        </p>
        <h3>Credits</h3>
        <p>Thanks to everybody !</p>
      </Trans>
    </Modal>
  );
};
export default AboutModal;
