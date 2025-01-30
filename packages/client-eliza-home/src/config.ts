export const DEFAULT_CONFIG = {
    DISCOVERY_INTERVAL: 300000, // 5 minutes
    STATE_UPDATE_INTERVAL: 60000, // 1 minute
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000, // 1 second
};

export const SUPPORTED_CAPABILITIES = [
    'switch',
    'light',
    'thermostat',
    'lock',
    'colorControl',
    'colorTemperature',
    'motionSensor',
    'contactSensor',
    'mediaPlayback',
];

export const CAPABILITY_MAPPINGS = {
    switch: ['switch'],
    light: ['switch', 'switchLevel', 'colorControl', 'colorTemperature'],
    thermostat: ['thermostat', 'temperatureMeasurement', 'humidityMeasurement'],
    lock: ['lock'],
    motionSensor: ['motionSensor'],
    contactSensor: ['contactSensor'],
    presenceSensor: ['presenceSensor'],
    mediaPlayer: ['mediaPlayback', 'volume'],
    windowShade: ['windowShade'],
    garageDoor: ['garageDoor'],
    fan: ['fanSpeed', 'switch'],
    powerMeter: ['powerMeter', 'energyMeter'],
    battery: ['battery']
};

export const DEVICE_CLASSES = {
    switch: 'switch',
    light: 'light',
    thermostat: 'climate',
    lock: 'lock',
    motionSensor: 'binary_sensor',
    contactSensor: 'binary_sensor',
    presenceSensor: 'binary_sensor',
    mediaPlayer: 'media_player',
    windowShade: 'cover',
    garageDoor: 'cover',
    fan: 'fan',
    powerMeter: 'sensor',
    battery: 'sensor'
};