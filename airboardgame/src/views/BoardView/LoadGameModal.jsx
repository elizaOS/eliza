import React from "react";
import { useTranslation } from "react-i18next";

import useGame from "../../hooks/useGame";

import Modal from "../../ui/Modal";

import { uploadResourceImage as uploadMedia } from "../../utils/api";
import { availableItemVisitor } from "../../utils/item";
import { ItemMediaUploader } from "../../utils/image";

import LoadData from "./LoadData";

const LoadGameModal = ({ show, setShow }) => {
  const { t } = useTranslation();
  const { setGame, gameId } = useGame();
  const [loading, setLoading] = React.useState();
  const [error, setError] = React.useState(false);
  const [fileCount, setFileCount] = React.useState(0);

  const loadGame = React.useCallback(
    async ({ game, files }) => {
      setLoading(true);

      setFileCount(0);

      const onFile = async (file) => {
        const url = await uploadMedia("game", gameId, files[file]);
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

        setGame(game);
        setShow(false);
      } catch (e) {
        console.log(e);
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [gameId, setGame, setShow]
  );

  React.useEffect(() => {
    if (show) {
      setError(false);
    }
  }, [show]);

  return (
    <Modal title={t("Load game")} setShow={setShow} show={show}>
      <header>
        <h3>{t("Load previously exported work?")}</h3>
      </header>
      <section>
        {loading ? (
          <p>{`#${fileCount} - ${t("Loading...")}`}</p>
        ) : (
          <LoadData onLoad={loadGame} />
        )}
        {error && <p className="error">{t("An error occurred. Try again!")}</p>}
      </section>
    </Modal>
  );
};

export default LoadGameModal;
