import React from "react";
import { nanoid } from "nanoid";
import styled from "styled-components";

import { RoomWrapper, useWire, useUsers } from "react-sync-board";

import { Routes, Route, Link, useParams } from "react-router-dom";
import Session from "../Session";
import UserCircle from "../../users/UserCircle";

import RoomNavBar from "./RoomNavBar";

import table from "../../media/images/table.png";
import { useTranslation } from "react-i18next";
import { useSocket } from "@scripters/use-socket.io";
import Waiter from "../../ui/Waiter";
import NavBar from "../../ui/NavBar";
import NavButton from "../../ui/NavButton";
import { FiChevronLeft } from "react-icons/fi";

const StyledPlayer = styled.li`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  transform: rotate(${({ rotate }) => rotate}deg);
  & > div {
    transform: rotate(-${({ rotate }) => rotate}deg);
  }
`;

const StyledRoom = styled.div`
  padding-top: 5em;
  background-color: var(--color-darkGrey);
  min-height: 100vh;
  & .tables {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    margin: 0 10%;
  }

  h3 {
    text-align: center;
  }

  & ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
`;

const StyledTable = styled.li`
  margin: 2em;
  position: relative;
  width: 250px;
  height: 250px;
  background-image: url(${table});
  background-size: cover;
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: ${({ add }) => (add ? "0.5" : "1")};
  & .players {
    position: absolute;
    top: -1em;
    left: -1em;
    right: -1em;
    bottom: -1em;
  }
  & a {
    z-index: 1;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 3em;
  }
  & .removeTable {
    z-index: 2;
    position: absolute;
    top: 0;
    right: 0;
    background: none;
    display: none;
  }

  &:hover {
    opacity: 1;
  }

  &:hover .removeTable {
    display: block;
  }
`;

const Room = ({ roomId, room, setRoom }) => {
  const { t } = useTranslation();
  const { users, joinSpace } = useUsers();

  const { isMaster } = useWire("room");

  const onAdd = () => {
    setRoom((prev) => ({
      ...prev,
      sessions: [...prev.sessions, { id: nanoid() }],
    }));
  };

  const onRemove = (idToRemove) => {
    setRoom((prev) => ({
      ...prev,
      sessions: prev.sessions.filter(({ id }) => id !== idToRemove),
    }));
  };

  React.useEffect(() => {
    joinSpace(roomId);
  }, [joinSpace, roomId]);

  const usersBySpace = React.useMemo(
    () =>
      room.sessions.map(({ id: sessionId }) => ({
        id: sessionId,
        users: users.filter(({ space }) => space === sessionId),
      })),
    [room.sessions, users]
  );

  return (
    <StyledRoom>
      <NavBar>
        <div className="keep-folded">
          <NavButton
            Icon={FiChevronLeft}
            to="/"
            alt={t("Go back")}
            title={t("Go back")}
          />
        </div>
        <div className="spacer" />
      </NavBar>
      <RoomNavBar />

      <h3>{t("Choose your board")}</h3>
      <ul className="tables">
        {usersBySpace.map(({ id: sessionId, users: spaceUsers }, index) => (
          <StyledTable key={sessionId}>
            <ul className="players">
              {spaceUsers.map((user, index) => {
                return (
                  <StyledPlayer
                    key={user.uid}
                    rotate={(360 / spaceUsers.length) * index}
                  >
                    <UserCircle {...user} />
                  </StyledPlayer>
                );
              })}
            </ul>
            <Link to={`/room/${roomId}/session/${sessionId}`}>
              <span>#{index + 1}</span>
            </Link>
            {isMaster && spaceUsers.length === 0 && (
              <button
                className="removeTable"
                onClick={() => onRemove(sessionId)}
              >
                X
              </button>
            )}
          </StyledTable>
        ))}
        {isMaster && (
          <StyledTable add>
            <button className="addTable" onClick={onAdd}>
              {t("Add new table")}
            </button>
          </StyledTable>
        )}
      </ul>
    </StyledRoom>
  );
};

const SubscribeRoomEvents = ({ room, setRoom }) => {
  const { wire, isMaster } = useWire("room");
  const roomRef = React.useRef(room);
  roomRef.current = room;

  // Register at startup
  React.useEffect(() => {
    const unsub = [];
    // Master register getRoom for peers
    if (isMaster) {
      const registerPromise = wire.register("getRoom", () => {
        return roomRef.current;
      });
      unsub.push(() => registerPromise.then((unregister) => unregister()));
    } else {
      // Others subscribe to roomUpdate
      unsub.push(
        wire.subscribe("roomUpdate", (newRoom) => {
          setRoom(newRoom);
        })
      );
    }
    return () => {
      unsub.forEach((u) => u());
    };
  }, [wire, isMaster, setRoom]);

  // Get Room from master at connection
  React.useEffect(() => {
    if (!isMaster) {
      const onGetRoom = (roomData) => {
        setRoom(roomData);
      };

      wire.call("getRoom").then(onGetRoom, () => {
        // retry later
        setTimeout(() => {
          wire.call("getRoom").then(onGetRoom, (error) => console.log(error));
        }, 2000);
      });
    }
  }, [wire, isMaster, setRoom]);

  // Send room update on change if master
  React.useEffect(() => {
    if (isMaster) {
      wire.publish("roomUpdate", room);
    }
  }, [wire, isMaster, room]);

  return null;
};

const StartSession = () => {
  const { sessionId } = useParams();
  return <Session sessionId={sessionId} />;
};

const RoomView = ({ roomId }) => {
  const [room, setRoom] = React.useState(() => ({
    sessions: [{ id: nanoid() }, { id: nanoid() }, { id: nanoid() }],
  }));

  return (
    <>
      <Routes>
        <Route
          path=""
          element={<Room roomId={roomId} room={room} setRoom={setRoom} />}
        />
        <Route path="session/:sessionId" element={<StartSession />} />
      </Routes>
      <SubscribeRoomEvents room={room} setRoom={setRoom} />
    </>
  );
};

const ConnectedRoomView = (props) => {
  const socket = useSocket();
  return (
    <RoomWrapper room={props.roomId} socket={socket} LoadingComponent={Waiter}>
      <RoomView {...props} />
    </RoomWrapper>
  );
};

export default ConnectedRoomView;
