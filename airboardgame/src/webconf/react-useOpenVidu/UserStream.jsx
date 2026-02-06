import React from "react";
import Stream from "./Stream";
import { FiMicOff } from "react-icons/fi";

const UserStream = ({ stream, name, color, audio, video, self = false }) => {
  return (
    <div className="user-stream">
      <Stream stream={stream} />
      {!self && !audio && (
        <div className="mic">
          <FiMicOff size="16" color="ffffff" />
        </div>
      )}
      {!self && (
        <span className="name" style={{ backgroundColor: color }}>
          {name}
        </span>
      )}
    </div>
  );
};

export default UserStream;
