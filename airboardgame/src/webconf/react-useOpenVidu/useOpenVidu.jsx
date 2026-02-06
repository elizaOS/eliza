import React from "react";
import { OpenVidu } from "openvidu-browser";
import { nanoid } from "nanoid";

export const OpenViduContext = React.createContext({});

class Stream {
  constructor({ stream, data, session }) {
    this.stream = stream;
    this.data = data;
    this._session = session;
    this.subscribed = false;
    this.subscriber = null;
    this.audio = true;
    this.video = true;
    this.uid = nanoid();
    this.toggleVideo = this.toggleVideo.bind(this);
    this.toggleAudio = this.toggleAudio.bind(this);
    this.toggleSubscribe = this.toggleSubscribe.bind(this);
  }
  subscribe() {
    if (this.subscribed) {
      return;
    }
    if (!this.subscriber) {
      this.subscriber = this._session.subscribe(this.stream);
    } else {
      this._session.subscribe(this.subscriber);
    }
    this.subscribed = true;
  }
  unsubscribe() {
    if (!this.subscribed) {
      return;
    }
    // We already had subscribed
    this.subscribed = false;
    this._session.unsubscribe(this.subscriber);
  }
  toggleSubscribe() {
    if (this.subscribed) {
      this.unsubscribe();
    } else {
      this.subscribe();
    }
  }
  enableVideo(value = true) {
    if (this.video === value) {
      return;
    }
    this._session.subscribeToVideo(value);
    this.video = value;
  }
  toggleVideo() {
    this.subscriber.publishVideo(!this.video);
    this.video = !this.video;
  }
  enableAudio(value = true) {
    if (this.audio === value) {
      return;
    }
    this._session.subscribeToAudio(value);
    this.audio = value;
  }
  toggleAudio() {
    this.subscriber.publishAudio(!this.audio);
    this.audio = !this.audio;
  }
  addVideoElement(elt) {
    if (!this.subscriber) {
      return;
    }
    this.subscriber.addVideoElement(elt);
  }
}

class LocalStream {
  constructor({ session, OV }) {
    this._session = session;
    this.published = false;
    this.publisher = null;
    this.audio = true;
    this.video = true;
    this.uid = nanoid();
    this._OV = OV;
    this.publishingPromiseResolve = null;
    this.unpublishingPromiseResolve = null;
    this.promiseQueue = new PromiseQueue();
  }

  publish(...params) {
    return this.promiseQueue.add(() => this._publish(...params));
  }

  unpublish() {
    return this.promiseQueue.add(() => this._unpublish());
  }

  _publish(config = {}, forceNew = false) {
    const configWithDefault = {
      audioSource: undefined, // The source of audio. If undefined default microphone
      videoSource: undefined, // The source of video. If undefined default webcam
      publishAudio: true, // Whether you want to start publishing with your audio unmuted or not
      publishVideo: true, // Whether you want to start publishing with your video enabled or not
      resolution: "320x240", // The resolution of your video
      frameRate: 10, // The frame rate of your video
      mirror: false, // Whether to mirror your local video or not
      ...config,
    };

    this.audio = configWithDefault.publishAudio;
    this.video = configWithDefault.publishVideo;

    if (!this.publisher || forceNew) {
      this.publisher = this._OV.initPublisher(undefined, configWithDefault);
    }

    const result = new Promise((resolve) => {
      this.publishingPromiseResolve = resolve;
    });

    this.publisher.once("streamCreated", () => {
      this.publishingPromiseResolve();
      this.publishingPromiseResolve = null;
      this.published = true;
    });

    this._session.publish(this.publisher);

    return result;
  }

  _unpublish() {
    const result = new Promise((resolve) => {
      this.unpublishingPromiseResolve = resolve;
    });

    this.publisher.once("streamDestroyed", () => {
      this.unpublishingPromiseResolve();
      this.unpublishingPromiseResolve = null;
      this.published = false;
    });

    this._session.unpublish(this.publisher);

    return result;
  }

  togglePublish() {
    if (this.published) {
      return this.unpublish();
    } else {
      return this.publish();
    }
  }
  enableVideo(value = true) {
    if (this.video === value) {
      return;
    }
    try {
      this.publisher.publishVideo(value);
    } catch (e) {
      setTimeout(() => {
        try {
          this.publisher.publishVideo(value);
        } catch (e) {
          console.log("Error while trying to change video publishing:", e);
        }
      }, 2000);
    }
    this.video = value;
  }
  toggleVideo() {
    this.publisher.publishVideo(!this.video);
    this.video = !this.video;
  }
  enableAudio(value = true) {
    if (this.audio === value) {
      return;
    }
    try {
      this.publisher.publishAudio(value);
    } catch (e) {
      setTimeout(() => {
        try {
          this.publisher.publishAudio(value);
        } catch (e) {
          console.log("Error while trying change audio publishing:", e);
        }
      }, 2000);
    }
    this.audio = value;
  }
  toggleAudio() {
    this.publisher.publishAudio(!this.audio);
    this.audio = !this.audio;
  }
  addVideoElement(elt) {
    if (!this.publisher) {
      return;
    }
    this.publisher.addVideoElement(elt);
  }
}

class PromiseQueue {
  constructor() {
    this.lastPromise = Promise.resolve(true);
  }

  add(operation, ...args) {
    return new Promise((resolve, reject) => {
      this.lastPromise = this.lastPromise
        .then(() => operation(...args))
        .then(resolve)
        .catch(reject);
    });
  }
}

class OpenViduConnection {
  constructor({ parseUserData, getUserData, onStreamUpdated, getToken }) {
    this.getToken = getToken;
    this.getUserData = getUserData;
    this.promiseQueue = new PromiseQueue();
    this.streams = [];
    this.disconnectPromise = null;

    const OV = new OpenVidu();
    OV.enableProdMode();

    const session = OV.initSession();

    session.on("streamCreated", (event) => {
      const newStream = new Stream({
        data: parseUserData(event.stream.connection.data),
        stream: event.stream,
        session: session,
      });
      this.streams = [...this.streams, newStream];
      onStreamUpdated(this.streams);
    });

    session.on("streamDestroyed", (event) => {
      this.streams = this.streams.filter(
        ({ stream }) => stream !== event.stream
      );

      onStreamUpdated(this.streams);
    });

    session.on("streamPropertyChanged", () => {
      // Just update the map to trigger the render
      this.streams = this.streams.slice();
      onStreamUpdated(this.streams);
    });

    session.on("sessionDisconnected", () => {
      this.disconnectPromiseResolve();
      this.disconnectPromiseResolve = null;
    });

    this.session = session;

    this.localStream = new LocalStream({
      session,
      OV,
    });
  }

  connect(room) {
    return this.promiseQueue.add(() => this._connect(room));
  }

  disconnect() {
    return this.promiseQueue.add(() => this._disconnect());
  }

  getLocalStream() {
    return this.localStream;
  }

  async _connect(room) {
    const token = await this.getToken(room);
    const userData = this.getUserData();
    await this.session.connect(token, userData);
  }

  async _disconnect() {
    const result = new Promise((resolve) => {
      this.disconnectPromiseResolve = resolve;
    });
    this.session.disconnect();
    return result;
  }
}

const defaultParseData = (d) => d;
const defaultSetData = () => nanoid();

export const OpenViduProvider = ({
  children,
  room,
  getToken,
  parseUserData = defaultParseData,
  getUserData = defaultSetData,
}) => {
  const OVRef = React.useRef(null);
  const [connected, setConnected] = React.useState(false);
  const [remoteStreams, setRemoteStreams] = React.useState([]);
  const [localStream, setLocalStream] = React.useState(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const joinSession = React.useCallback(
    async ({ room, parseUserData, getUserData, getToken }) => {
      if (!OVRef.current) {
        OVRef.current = new OpenViduConnection({
          parseUserData,
          getUserData,
          onStreamUpdated: (newValue) => {
            setRemoteStreams(newValue);
          },
          getToken,
        });
      }

      await OVRef.current.connect(room);
    },
    []
  );

  React.useEffect(() => {
    let mounted = true;

    const join = async () => {
      await joinSession({ room, parseUserData, getUserData, getToken });

      if (!mounted) {
        return;
      }

      setLocalStream(OVRef.current.getLocalStream());
      setConnected(true);
    };
    join();

    return () => {
      mounted = false;
      OVRef.current.disconnect();
    };
  }, [getUserData, joinSession, parseUserData, room, getToken]);

  React.useEffect(() => {
    const onLeave = () => {
      OVRef.current.disconnect();
    };

    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  return (
    <OpenViduContext.Provider value={{ remoteStreams, localStream }}>
      {connected && children}
    </OpenViduContext.Provider>
  );
};

const useOpenVidu = () => {
  return React.useContext(OpenViduContext);
};

export default useOpenVidu;
