import React from "react";
import styled from "styled-components";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FiPlusSquare } from "react-icons/fi";

const Game = styled.li`
  position: relative;
  padding: 0em;
  margin: 0px;

  & .game-name {
    max-width: 80%;
    line-height: 1.2em;
    overflow: hidden;
    margin-bottom: 3px;
    margin: 0.2em 0 0.5em 0;
    font-size: 2.3vw;
  }

  & .img-wrapper {
    display: block;
    position: relative;
    width: 100%;
    padding-top: 64.5%;
    & > span {
      background-color: var(--color-blueGrey);
      position: absolute;
      inset: 0;
      overflow: hidden;
      display: flex;
      justify-content: center;
      align-items: center;
      border-radius: 5px;
      & img {
        flex: 0;
      }
    }
  }

  @media screen and (max-width: 1024px) {
    & {
      flex-basis: 45%;
    }
    & .details {
      font-size: 12px;
    }
    & .game-name {
      font-size: 28px;
    }
  }

  @media screen and (max-width: 640px) {
    & {
      flex-basis: 100%;
    }
    & .game-name {
      font-size: 24px;
    }
  }
`;

const GameListItem = () => {
  const { t } = useTranslation();

  return (
    <Game>
      <Link
        to={"/game/"}
        className="img-wrapper"
        title={t("Create a new game")}
      >
        <span>
          <FiPlusSquare
            color="#f9fbfa"
            size="120"
            alt={t("Create a new game")}
          />
        </span>
      </Link>
      <div className="details">
        <span></span>
      </div>

      <h2 className="game-name">{t("Create a new game")}</h2>
    </Game>
  );
};

export default GameListItem;
