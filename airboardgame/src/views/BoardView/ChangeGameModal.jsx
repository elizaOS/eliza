import React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { useQuery } from "react-query";

import Modal from "../../ui/Modal";
import { getGames } from "../../utils/api";
import useSession from "../../hooks/useSession";

import GameListItem from "../GameListItem";

const StyledGameList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
`;

const ChangeGameModalContent = ({ onLoad }) => {
  const { t } = useTranslation();
  const { changeGame } = useSession();

  const { isLoading, data: gameList } = useQuery("games", async () =>
    (await getGames())
      .filter((game) => game.board.published)
      .sort((a, b) => {
        const [nameA, nameB] = [
          a.board.defaultName || a.board.name,
          b.board.defaultName || b.board.name,
        ];
        if (nameA < nameB || a.id === "demo") {
          return -1;
        }
        if (nameA > nameB || b.id === "demo") {
          return 1;
        }
        return 0;
      })
  );

  const onGameClick = React.useCallback(
    (id) => {
      changeGame(id);
      onLoad();
    },
    [changeGame, onLoad]
  );

  return (
    <>
      <header>
        <h3>{t("Choose a new game")}</h3>
      </header>
      <section>
        <StyledGameList>
          {!isLoading &&
            gameList.map((game) => (
              <GameListItem key={game.id} game={game} onClick={onGameClick} />
            ))}
        </StyledGameList>
      </section>
    </>
  );
};

const ChangeGameModal = ({ show, setShow }) => {
  const { t } = useTranslation();
  const closeModal = React.useCallback(() => setShow(false), [setShow]);
  return (
    <Modal
      title={t("Change game")}
      setShow={setShow}
      show={show}
      position="left"
    >
      <ChangeGameModalContent onLoad={closeModal} />
    </Modal>
  );
};

export default ChangeGameModal;
