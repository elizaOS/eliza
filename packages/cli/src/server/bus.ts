import EventEmitter from 'events';

/**
 * A simple in-memory message bus for distributing messages from the central server
 * to subscribed MessageBusService instances within the same process.
 *
 * For multi-process or multi-server deployments, this would need to be replaced
 * with a more robust solution like Redis Pub/Sub, Kafka, RabbitMQ, etc.
 */
class InternalMessageBus extends EventEmitter {}

const internalMessageBus = new InternalMessageBus();

// Increase the default max listeners if many agents might be running in one process
internalMessageBus.setMaxListeners(50);

export default internalMessageBus;
