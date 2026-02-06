import React from "react";

const Stream = ({ stream }) => {
  const videoRef = React.useRef(null);

  React.useEffect(() => {
    stream.addVideoElement(videoRef.current);
  }, [stream]);

  return (
    <video
      autoPlay={true}
      ref={videoRef}
      style={{ width: "100%", display: "block" }}
    />
  );
};

export default Stream;
