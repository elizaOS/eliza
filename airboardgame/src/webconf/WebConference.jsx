import React from "react";
import styled from "styled-components";

import { getConfToken } from "../utils/api";
import useLocalStorage from "../hooks/useLocalStorage";

import { OpenViduProvider, StreamList } from "./react-useOpenVidu";

const StyledWebConference = styled.div`
  position: fixed;
  top: 5px;
  right: 45px;
  line-height: 1em;
  bottom: 5.5em;
  z-index: 1;
  width: ${({ audioOnly }) => (audioOnly ? 80 : 150)}px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.5em;

  .stream-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  & .local-stream {
    position: relative;
    & .actions {
      position: absolute;
      bottom: 2px;
      right: 0;
      left: 0;
      display: flex;
      justify-content: center;
    }

    & button {
      padding: 0;
      margin: 0;
      background-color: transparent;
      width: 30px;
      height: 30px;
    }
  }

  & .remote-stream {
    position: relative;
  }

  & .user-stream {
    position: relative;
    border: 1px solid #333;
    & .name {
      line-height: 1.6em;
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      padding: 1px 2px;
      background-color: #95959540;
      text-align: center;
    }
    & .mic {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 30px;
      height: 30px;
      padding: 7px;
      & img {
        max-height: 100%;
      }
    }
  }
`;

const WebConference = ({ room, currentUser, users, enableVideo = false }) => {
  const getUserData = React.useCallback(
    () => JSON.stringify({ uid: currentUser.uid }),
    [currentUser.uid]
  );

  const [showLocalVideo, setShowLocalVideo] = useLocalStorage(
    "wcEnableLocalVideo",
    false
  );
  const [showLocalAudio, setShowLocalAudio] = useLocalStorage(
    "wcEnableLocalAudio",
    true
  );

  return (
    <OpenViduProvider
      room={room}
      parseUserData={JSON.parse}
      getUserData={getUserData}
      getToken={getConfToken}
    >
      <StyledWebConference audioOnly={true}>
        <StreamList
          currentUser={currentUser}
          users={users}
          audioOnly={!enableVideo}
          setLocalAudio={setShowLocalAudio}
          setLocalVideo={setShowLocalVideo}
          enableLocalVideo={showLocalVideo}
          enableLocalAudio={showLocalAudio}
        />
      </StyledWebConference>
    </OpenViduProvider>
  );
};

export default WebConference;
