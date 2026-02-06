import React from "react";
import { useTranslation } from "react-i18next";

import Modal from "../../ui/Modal";

import LoadVassalModule from "./LoadVassalModule";

const LoadVassalGameModal = ({ show, setShow }) => {
  const { t } = useTranslation();
  const [canClose, setCanClose] = React.useState(true);

  const onStart = React.useCallback(() => {
    setCanClose(false);
  }, []);

  const onLoad = React.useCallback(
    (err) => {
      setCanClose(true);
      if (!err) {
        setShow(false);
      }
    },
    [setShow]
  );

  return (
    <Modal
      title={t("Load a Vassal module")}
      setShow={setShow}
      show={show}
      canClose={canClose}
    >
      <header>
        <h3>{t("Load a Vassal module?")}</h3>
      </header>
      <section>
        <LoadVassalModule onStart={onStart} onLoad={onLoad} />
      </section>
    </Modal>
  );
};

export default LoadVassalGameModal;
