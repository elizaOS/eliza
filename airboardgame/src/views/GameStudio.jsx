import React from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { useQuery } from "react-query";

import { getGames } from "../utils/api";
import useAuth from "../hooks/useAuth";

import { StyledGameList } from "./StyledGameList";
import NewGameItem from "./NewGameItem";
import GameListItem from "./GameListItem";
import Waiter from "../ui/Waiter";

const Filter = styled.div`
  & .incentive {
    width: 100%;
    text-align: center;
    font-size: 3.5vw;
    padding: 0.5em;
    margin: 0;
  }
  @media screen and (max-width: 1024px) {
    & .incentive {
      font-size: 32px;
    }
  }
`;

const Content = styled.div`
  background-color: var(--bg-secondary-color);
`;

const GameListView = () => {
  const { t } = useTranslation();

  const { isAuthenticated, userId, userAccount } = useAuth();

  const isAdmin = userAccount?.isAdmin;

  const { isLoading, data: gameList } = useQuery("ownGames", async () =>
    (await getGames())
      .filter(
        ({ owner }) => (userId && (!owner || owner === userId)) || isAdmin
      )
      .sort((a, b) => {
        const [nameA, nameB] = [
          a?.board?.defaultName || a?.board?.name,
          b?.board?.defaultName || b?.board?.name,
        ];
        if (nameA < nameB) {
          return -1;
        }
        if (nameA > nameB) {
          return 1;
        }
        return 0;
      })
  );

  if (!isAuthenticated) {
    return <Navigate to="/games/" />;
  }

  return (
    <Content>
      <Filter>
        <h2 className="incentive">{t("Your games")}</h2>
      </Filter>
      <StyledGameList>
        <NewGameItem />
        {!isLoading &&
          gameList.map((game) => (
            <GameListItem
              key={game.id}
              game={game}
              userId={userId}
              isAdmin={isAdmin}
              studio={true}
            />
          ))}
        {isLoading && <Waiter />}
      </StyledGameList>
    </Content>
  );
};

export default GameListView;
