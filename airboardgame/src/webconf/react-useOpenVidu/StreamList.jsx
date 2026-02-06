import React from "react";

import useOpenVidu from "./useOpenVidu";

import LocalStream from "./LocalStream";
import RemoteStream from "./RemoteStream";
import { FiCamera, FiCameraOff, FiMic, FiMicOff } from "react-icons/fi";

const StreamList = ({
  currentUser,
  users,
  audioOnly = true,
  enableLocalVideo = false,
  enableLocalAudio = true,
  setLocalVideo = () => {},
  setLocalAudio = () => {},
}) => {
  const { remoteStreams = [], localStream } = useOpenVidu();

  const streamMap = React.useMemo(
    () =>
      remoteStreams.reduce((acc, stream) => {
        acc[stream.data.uid] = stream;
        return acc;
      }, {}),
    [remoteStreams]
  );

  const otherUsers = users.filter(({ uid }) => uid !== currentUser.uid);

  return (
    <div className="stream-list">
      {localStream && (
        <div className="local-stream">
          <LocalStream
            stream={localStream}
            video={enableLocalVideo && !audioOnly}
            audio={enableLocalAudio}
            user={currentUser}
          />
          <div className="actions">
            {!audioOnly && (
              <button
                onClick={() => setLocalVideo(!enableLocalVideo)}
                className={enableLocalVideo ? "active" : ""}
              >
                {enableLocalVideo ? (
                  <FiCamera size="16" color="#f9fbfa" />
                ) : (
                  <FiCameraOff size="16" color="#f9fbfa" />
                )}
              </button>
            )}
            <button
              onClick={() => setLocalAudio(!enableLocalAudio)}
              className={enableLocalAudio ? "active" : ""}
            >
              {enableLocalAudio ? (
                <FiMic size="16" color="#f9fbfa" />
              ) : (
                <FiMicOff size="16" color="#f9fbfa" />
              )}
            </button>
          </div>
        </div>
      )}
      {otherUsers.map(
        (user) =>
          streamMap[user.uid] && (
            <div key={user.uid} className="remote-stream">
              <RemoteStream stream={streamMap[user.uid]} user={user} />
            </div>
          )
      )}
    </div>
  );
};

export default StreamList;
