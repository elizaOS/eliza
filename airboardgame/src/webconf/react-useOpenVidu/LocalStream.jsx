import React from "react";

import UserStream from "./UserStream";

const LocalStream = ({
  stream,
  user,
  publish = true,
  audio = true,
  video = true,
}) => {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    const publishStream = async () => {
      if (publish) {
        await stream.publish({ publishAudio: audio, publishVideo: video });
        if (mounted) {
          setShow(true);
        }
      } else {
        await stream.unpublish();
      }
    };
    publishStream();
    return () => {
      mounted = false;
    };
    // No need to react on audio or video value change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, stream]);

  React.useEffect(() => {
    stream.enableVideo(video);
  }, [stream, video]);

  React.useEffect(() => {
    stream.enableAudio(audio);
  }, [stream, audio]);

  React.useEffect(() => {
    return () => {
      stream.unpublish();
    };
  }, [stream]);

  if (!stream || !show) {
    return null;
  }

  return (
    <UserStream
      stream={stream}
      self={true}
      name={user.name}
      color={user.color}
      audio={audio}
      video={video}
    />
  );
};

export default LocalStream;
