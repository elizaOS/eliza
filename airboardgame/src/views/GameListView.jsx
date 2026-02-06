import React from "react";
import { useTranslation, Trans } from "react-i18next";
import styled from "styled-components";
import { useQuery } from "react-query";
import { NavLink } from "react-router-dom";

import SliderRange from "../ui/SliderRange";

import playerSVG from "../media/images/player.svg";
import languageSVG from "../media/images/language.svg";
import clockSVG from "../media/images/clock.svg";

import { getGames } from "../utils/api";
import { search } from "../utils";

import GameListItem from "./GameListItem";
import { StyledGameList } from "./StyledGameList";
import Waiter from "../ui/Waiter";

const Header = styled.header`
  background-color: var(--bg-color);
  position: relative;

  background: linear-gradient(
      180deg,
      rgba(0, 0, 0, 1) 0%,
      rgba(0, 0, 0, 0.6) 40%,
      rgba(0, 0, 0, 0.6) 60%,
      rgba(0, 0, 0, 1) 100%
    ),
    100% 50% / contain no-repeat url(/hero.png);

  padding: 14vh 5%;
  margin-bottom: 20px;

  & .baseline {
    padding: 2px;
    font-weigth: 800;
    font-size: 3.2vw;
    line-height: 1.2em;
  }
  & .subbaseline {
    padding: 2px;
    color: var(--font-color2);
    font-size: 1.4vw;
  }

  @media screen and (max-width: 1024px) {
    & {
      padding: 1em 5%;
    }
    & .baseline {
      display: inline-block;
      background-color: #00000088;
      font-size: 32px;
    }
    & .subbaseline {
      display: inline-block;
      background-color: #00000088;
      font-size: 16px;
    }
  }

  @media screen and (max-width: 640px) {
    & {
      display: none;
    }
  }
`;

const Filter = styled.div`
  text-align: center;

  & .incentive {
    width: 100%;
    font-size: 3.5vw;
    padding: 0.5em;
    padding-bottom: 0;
    margin: 0;
    line-height: 1em;
  }

  & .subincentive {
    font-size: 1.3em;
  }

  @media screen and (max-width: 1024px) {
    & .incentive {
      font-size: 32px;
    }
  }

  input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="color"]):not([type="button"]):not([type="reset"]) {
    background-color: #1c1c1c;
    color: var(--font-color2);
    max-width: 30rem;
    display: inline;
    margin: 2rem;

    &::placeholder {
      color: var(--font-color2);
    }
  }
`;

const StyledGameFilters = styled.ul`
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  padding: 0;

  > li {
    flex: auto;
    max-width: 25rem;
    margin: 1rem;
    padding: 1.5rem 1rem 1rem;
    text-align: center;
    border-radius: 0.5rem;

    .filter-title {
      text-transform: uppercase;
      color: var(--font-color2);
      font-size: 1.3rem;
    }

    &.small-filter {
      max-width: 20rem;
    }
  }

  .language-filter {
    background: url(${languageSVG}) #1d1d1d no-repeat -35% -25%;

    ul {
      text-align: left;

      list-style: none;
      padding: 0;
      color: var(--font-color2);
    }
  }

  .player-filter {
    background: url(${playerSVG}) #1d1d1d no-repeat -35% -25%;
  }

  .duration-filter {
    background: url(${clockSVG}) #1d1d1d no-repeat -40% -40%;
  }
`;

const StyledGameResultNumber = styled.p`
  text-align: center;
`;

const Content = styled.div`
  background-color: var(--bg-secondary-color);
`;

const hasIntervalOverlap = (interval1, interval2) => {
  return interval1[0] <= interval2[1] && interval1[1] >= interval2[0];
};

const hasRequestedValues = (filterValue, gameSettings) => {
  if (!filterValue?.length || !gameSettings?.length) {
    return true;
  }
  return hasIntervalOverlap(filterValue, gameSettings);
};

const hasAllowedMaterialLanguage = (filterCriteria, game) => {
  const MULTI_LANG_KEYWORD = "Multi-lang";

  return (
    !game.board.materialLanguage ||
    game.board.materialLanguage === MULTI_LANG_KEYWORD ||
    filterCriteria.languages.includes(game.board.materialLanguage)
  );
};

const GameListView = () => {
  const { t } = useTranslation();
  const NULL_SEARCH_TERM = "";

  const [filterCriteria, setFilterCriteria] = React.useState({
    searchTerm: NULL_SEARCH_TERM,
    nbOfPlayers: [1, 9],
    durations: [15, 90],
    languages: ["fr", "en"],
  });

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

  const filteredGameList = React.useMemo(() => {
    if (gameList) {
      return gameList.filter(
        (game) =>
          (filterCriteria.searchTerm === NULL_SEARCH_TERM ||
            search(filterCriteria.searchTerm, game.board.defaultName)) &&
          hasRequestedValues(
            filterCriteria.nbOfPlayers,
            game.board.playerCount
          ) &&
          hasRequestedValues(filterCriteria.durations, game.board.duration) &&
          hasAllowedMaterialLanguage(filterCriteria, game)
      );
    }
    return [];
  }, [gameList, filterCriteria]);

  const onChangeNbOfPlayersSlider = (values) => {
    setFilterCriteria({
      ...filterCriteria,
      nbOfPlayers: values,
    });
  };

  const onChangeDurationSlider = (values) => {
    setFilterCriteria({
      ...filterCriteria,
      durations: values,
    });
  };

  const onChangeSearchTerm = (event) => {
    setFilterCriteria({
      ...filterCriteria,
      searchTerm: event.target.value,
    });
  };

  const toggleLang = (lang) => {
    if (filterCriteria.languages.includes(lang)) {
      return filterCriteria.languages.filter((language) => language !== lang);
    } else {
      return [...filterCriteria.languages, lang];
    }
  };

  const onChangelanguageFilter = (lang) => {
    setFilterCriteria({
      ...filterCriteria,
      languages: toggleLang(lang),
    });
  };

  return (
    <>
      <Header>
        <Trans i18nKey="baseline">
          <h2 className="baseline">
            Play board games online
            <br />
            with your friends - for free!
          </h2>
          <p className="subbaseline">
            Choose from our selection or create your own.
            <br />
            No need to sign up. Just start a game and share the link with your
            friends.
          </p>
        </Trans>
      </Header>
      <Content>
        <Filter>
          <h2 className="incentive">{t("Start a game now")}</h2>
          <h3 className="subincentive">
            {t("Or")}{" "}
            <NavLink to={"/room/"}>{t("start a multi room session")}</NavLink>
          </h3>
          <h3 className="subincentive">
            {t("Or")}{" "}
            <NavLink to={"/playvassalgame/"}>
              {t("Load a Vassal module")}
            </NavLink>
          </h3>
          <input
            type="search"
            id="game-search"
            name="game-search"
            aria-label={t("Search for a game")}
            placeholder={t("Search for a game")}
            value={filterCriteria.searchTerm}
            onChange={onChangeSearchTerm}
          />
          <StyledGameFilters>
            <li className="player-filter">
              <span className="filter-title">{t("Number of players")}</span>
              <SliderRange
                defaultValue={[1, 9]}
                min={1}
                max={9}
                value={filterCriteria.nbOfPlayers}
                step={1}
                onChange={onChangeNbOfPlayersSlider}
              />
            </li>
            <li className="duration-filter">
              <span className="filter-title">{t("Duration (mins)")}</span>
              <SliderRange
                defaultValue={[15, 90]}
                min={15}
                max={90}
                value={filterCriteria.durations}
                step={15}
                onChange={onChangeDurationSlider}
              />
            </li>
            <li className="small-filter language-filter">
              <span className="filter-title">{t("Language")}</span>
              <div>
                <ul>
                  <li>
                    <input
                      type="checkbox"
                      id="french-filter"
                      name="french-filter"
                      defaultChecked={filterCriteria.languages.includes("fr")}
                      onChange={() => onChangelanguageFilter("fr")}
                    />
                    <label htmlFor="french-filter">{t("French")}</label>
                  </li>
                  <li>
                    <input
                      type="checkbox"
                      id="english-filter"
                      name="english-filter"
                      defaultChecked={filterCriteria.languages.includes("en")}
                      onChange={() => onChangelanguageFilter("en")}
                      data-lang="en"
                    />
                    <label htmlFor="english-filter">{t("English")}</label>
                  </li>
                </ul>
              </div>
            </li>
          </StyledGameFilters>
          <StyledGameResultNumber>
            {t("games-available", { nbOfGames: `${filteredGameList.length}` })}
          </StyledGameResultNumber>
        </Filter>
        {!isLoading && (
          <StyledGameList>
            {filteredGameList.map((game) => (
              <GameListItem key={game.id} game={game} />
            ))}
          </StyledGameList>
        )}
        {isLoading && <Waiter />}
      </Content>
    </>
  );
};

export default GameListView;
