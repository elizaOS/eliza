import React from "react";
import { useTranslation } from "react-i18next";

import useSession from "../../hooks/useSession";
import { uploadResourceImage as uploadMedia } from "../../utils/api";
import { availableItemVisitor } from "../../utils/item";
import { ItemMediaUploader } from "../../utils/image";

import Modal from "../../ui/Modal";

import LoadData from "./LoadData";

const LoadSessionModal = ({ show, setShow }) => {
  const { t } = useTranslation();
  const { setSession, sessionId } = useSession();
  const [loading, setLoading] = React.useState();
  const [error, setError] = React.useState(false);
  const [fileCount, setFileCount] = React.useState(0);

  const loadSession = React.useCallback(
    async ({ game, files }) => {
      setError(false);
      setLoading(true);
      setFileCount(0);

      const onFile = (file) => {
        if (!files[file]) {
          setFileCount((prev) => prev + 1);
          console.error(`File ${file} not found in archive`);
          return null;
        }
        const url = uploadMedia("session", sessionId, files[file]);
        setFileCount((prev) => prev + 1);
        return url;
      };

      const itemMediaUploader = new ItemMediaUploader(onFile);

      try {
        game.items = await Promise.all(
          game.items.map((item) => itemMediaUploader.upload(item))
        );
        game.availableItems = await availableItemVisitor(
          game.availableItems,
          (item) => itemMediaUploader.upload(item)
        );

        game.board.imageUrl = await itemMediaUploader.uploadMedia(
          game.board.imageUrl
        );
        if (game.board?.bgConf?.img) {
          game.board.bgConf.img = await itemMediaUploader.uploadMedia(
            game.board.bgConf.img
          );
        }

        setSession(game);
        setShow(false);
      } catch (e) {
        console.log(e);
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, setSession, setShow]
  );

  React.useEffect(() => {
    if (show) {
      setError(false);
    }
  }, [show]);

  return (
    <Modal title={t("Load session")} setShow={setShow} show={show}>
      <header>
        <h3>{t("Continue a saved game session?")}</h3>
      </header>
      <section>
        {loading ? (
          <p>{`#${fileCount} - ${t("Loading...")}`}</p>
        ) : (
          <LoadData onLoad={loadSession} />
        )}
        {error && <p className="error">{t("An error occurred. Try again!")}</p>}
      </section>
    </Modal>
  );
};

export default LoadSessionModal;
