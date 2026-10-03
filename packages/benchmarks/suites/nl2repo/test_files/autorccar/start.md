## Introduction and Goals of the AutoRCCar Project

AutoRCCar is a Python system **targeted at the control of autonomous remote - controlled cars**, capable of real - time video stream processing, neural network model training, and intelligent driving decision - making. This tool excels in the fields of autonomous driving and machine learning, achieving "a complete end - to - end autonomous driving process and optimized control performance". Its core functions include: real - time video processing (automatically collecting and processing the video stream from the Raspberry Pi camera module), **neural network model training and prediction** (supporting image recognition and driving decision - making), and intelligent processing of special scenarios such as stop signs, traffic lights, and distance measurement. In short, AutoRCCar is dedicated to providing a robust autonomous driving system for the intelligent control of remote - controlled cars (for example, converting images into control instructions through neural network models and making driving decisions through multi - sensor fusion).

## Natural Language Instruction (Prompt)

Please create a Python project named AutoRCCar to implement a complete autonomous remote - controlled car system. The project should include the following functions:

1. Video stream processing module: It can collect video streams in real - time from the Raspberry Pi camera module, support JPEG format encoding and transmission, and achieve low - latency video data transmission. The processing result should be an OpenCV image object, supporting real - time display and image pre - processing (such as grayscale conversion, ROI extraction, etc.).

2. Neural network model training: Implement a neural network model based on OpenCV, which can learn driving decisions from training image data. It should support functions such as image data collection, model training, prediction verification, etc. The model architecture is a fully connected network of 76800→32→4, using the Sigmoid activation function and back - propagation training.

3. Object detection system: Detect and recognize key objects such as stop signs and traffic lights, and use a cascade classifier to achieve real - time object detection. It should support functions such as Haar feature detection, distance measurement, and safety distance judgment.

4. Sensor data fusion: Integrate ultrasonic sensor data to achieve distance measurement and collision avoidance functions. It should support real - time distance data reception, safety threshold judgment, emergency stop control, etc.

5. Hardware control interface: Design an Arduino control interface to achieve precise control of the RC car. It should support basic actions such as forward, backward, left turn, and right turn, as well as compound actions (such as forward left turn, backward right turn, etc.).


6. Core file requirements: The project must include a complete environment.yml file. This file should configure the project as an installable package (supporting pip install) and declare a complete list of dependencies (such as opencv - python==4.12.0.88, numpy==2.2.6, scikit - learn==1.7.1, pygame==2.6.1, etc., the actual core libraries used). The environment.yml should ensure that all core functional modules can work properly. The project needs to provide computer/rc_driver.py as the main entry point for the autonomous driving program, importing the neural network model and control functions from the model and rc_driver_helper modules. In model.py, there should be a NeuralNetwork class containing functions such as create(), train(), evaluate(), save_model(), load_model(), predict(), and a load_data() function for data loading. In rc_driver_helper.py, there should be an RCControl class containing steer() and stop() functions, a DistanceToCamera class containing a calculate() function, and an ObjectDetection class containing a detect() function. The project should export these core classes and provide complete test cases, enabling users to start the autonomous driving system with a simple "python rc_driver.py" command. Users should be able to access all main functions through simple statements such as "from rc_driver import **".

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.7

### Core Dependency Library Versions

```Plain
anyio                     4.10.0
argon2-cffi               25.1.0
argon2-cffi-bindings      25.1.0
arrow                     1.3.0
asttokens                 3.0.0
async-lru                 2.0.5
attrs                     25.3.0
babel                     2.17.0
beautifulsoup4            4.13.4
bleach                    6.2.0
certifi                   2025.8.3
cffi                      1.17.1
charset-normalizer        3.4.3
comm                      0.2.3
contourpy                 1.3.3
cycler                    0.12.1
Cython                    3.1.3
debugpy                   1.8.16
decorator                 5.2.1
defusedxml                0.7.1
executing                 2.2.0
fastjsonschema            2.21.2
fonttools                 4.59.1
fqdn                      1.5.1
h11                       0.16.0
httpcore                  1.0.9
httpx                     0.28.1
idna                      3.10
iniconfig                 2.1.0
ipykernel                 6.30.1
ipython                   9.4.0
ipython_pygments_lexers   1.1.1
ipywidgets                8.1.7
isoduration               20.11.0
jedi                      0.19.2
Jinja2                    3.1.6
joblib                    1.5.1
json5                     0.12.1
jsonpointer               3.0.0
jsonschema                4.25.1
jsonschema-specifications 2025.4.1
jupyter                   1.1.1
jupyter_client            8.6.3
jupyter-console           6.6.3
jupyter_core              5.8.1
jupyter-events            0.12.0
jupyter-lsp               2.2.6
jupyter_server            2.16.0
jupyter_server_terminals  0.5.3
jupyterlab                4.4.6
jupyterlab_pygments       0.3.0
jupyterlab_server         2.27.3
jupyterlab_widgets        3.0.15
kiwisolver                1.4.9
lark                      1.2.2
MarkupSafe                3.0.2
matplotlib                3.10.5
matplotlib-inline         0.1.7
mistune                   3.1.3
nbclient                  0.10.2
nbconvert                 7.16.6
nbformat                  5.10.4
nest-asyncio              1.6.0
notebook                  7.4.5
notebook_shim             0.2.4
numpy                     2.2.6
opencv-python             4.12.0.88
overrides                 7.7.0
packaging                 25.0
pandocfilters             1.5.1
parso                     0.8.4
pexpect                   4.9.0
pillow                    11.3.0
pip                       23.2.1
platformdirs              4.3.8
pluggy                    1.6.0
prometheus_client         0.22.1
prompt_toolkit            3.0.51
psutil                    7.0.0
ptyprocess                0.7.0
pure_eval                 0.2.3
pycparser                 2.22
pygame                    2.6.1
Pygments                  2.19.2
pyparsing                 3.2.3
pyserial                  3.5
pytest                    8.4.1
python-dateutil           2.9.0.post0
python-json-logger        3.3.0
PyYAML                    6.0.2
pyzmq                     27.0.1
referencing               0.36.2
requests                  2.32.5
rfc3339-validator         0.1.4
rfc3986-validator         0.1.1
rfc3987-syntax            1.1.0
rpds-py                   0.27.0
scikit-learn              1.7.1
scipy                     1.16.1
Send2Trash                1.8.3
setuptools                65.5.1
six                       1.17.0
sniffio                   1.3.1
soupsieve                 2.7
stack-data                0.6.3
terminado                 0.18.1
threadpoolctl             3.6.0
tinycss2                  1.4.0
tornado                   6.5.2
traitlets                 5.14.3
types-python-dateutil     2.9.0.20250809
typing_extensions         4.14.1
uri-template              1.3.0
urllib3                   2.5.0
wcwidth                   0.2.13
webcolors                 24.11.1
webencodings              0.5.1
websocket-client          1.8.0
wheel                     0.42.0
widgetsnbextension        4.0.14
```

## AutoRCCar Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitattributes
├── LICENSE.md
├── Traffic_signal
│   ├── Readme.md
│   ├── Traffic_Signal_schem.jpg
│   ├── Traffic_signal.ino
├── arduino
│   ├── README.md
│   ├── rc_keyboard_control.ino
├── computer
│   ├── README.md
│   ├── cascade_xml
│   │   ├── stop_sign.xml
│   │   ├── traffic_light.xml
│   ├── chess_board
│   │   ├── frame01.jpg
│   │   ├── frame02.jpg
│   │   ├── frame03.jpg
│   │   ├── frame04.jpg
│   │   ├── frame05.jpg
│   │   ├── frame06.jpg
│   │   ├── frame07.jpg
│   │   ├── frame08.jpg
│   │   ├── frame09.jpg
│   │   ├── frame10.jpg
│   │   ├── frame11.jpg
│   │   ├── frame12.jpg
│   │   ├── frame13.jpg
│   │   ├── frame14.jpg
│   │   ├── frame15.jpg
│   │   ├── frame16.jpg
│   │   ├── frame17.jpg
│   │   ├── frame18.jpg
│   │   ├── frame19.jpg
│   │   ├── frame20.jpg
│   ├── collect_training_data.py
│   ├── model.py
│   ├── model_training.py
│   ├── picam_calibration.py
│   ├── rc_driver.py
│   ├── rc_driver_helper.py
│   ├── rc_driver_nn_only.py
├── environment.yml
├── raspberryPi
│   ├── README.md
│   ├── stream_client.py
│   ├── stream_client_fast.py
│   ├── ultrasonic_client.py
└── README.md

```

## API Usage Guide

### Core APIs

#### 1. Module Import
```python
import cv2
import numpy as np
import serial
import pygame
from pygame.locals import K_UP, K_DOWN, K_LEFT, K_RIGHT, K_x, K_q

# Import of core functions
from model import NeuralNetwork, load_data
from rc_driver_helper import RCControl, DistanceToCamera, ObjectDetection

# Import of server functions (for video stream and sensor data processing)
from rc_driver import SensorDataHandler, VideoStreamHandler, Server
```

#### 2. load_data() Function - Training Data Loading

**Function**: Load training data from a specified path, perform data pre - processing, and split the data into training and validation sets.

**Function Signature**:
```python
def load_data(input_size, path):
```

**Parameter Description**:
- `input_size` (int): The size of the input image (number of pixels)
- `path` (str): The path to the training data file, supporting glob pattern matching

**Return Value**: A tuple containing the training set and validation set (X_train, X_test, y_train, y_test)

**Usage Example**:
```python
# Load training data
X_train, X_test, y_train, y_test = load_data(76800, "training_data/*.npz")
```

#### 3. NeuralNetwork Class - Neural Network Model

**Function**: A neural network model based on OpenCV for autonomous driving decision prediction.

**Class Methods**:

##### 3.1 create() Method - Create a Neural Network

**Function Signature**:
```python
def create(self, layer_sizes):
```

**Parameter Description**:
- `layer_sizes` (np.ndarray): The number of nodes in each layer of the neural network, such as [76800, 32, 4]

**Usage Example**:
```python
nn = NeuralNetwork()
nn.create(np.int32([76800, 32, 4]))
```

##### 3.2 train() Method - Train the Model

**Function Signature**:
```python
def train(self, X, y):
```

**Parameter Description**:
- `X` (np.ndarray): Training feature data, with a shape of (n_samples, n_features)
- `y` (np.ndarray): Training label data, with a shape of (n_samples, n_classes)

**Usage Example**:
```python
nn.train(X_train, y_train)
```

##### 3.3 evaluate() Method - Model Evaluation

**Function Signature**:
```python
def evaluate(self, X, y):
```

**Parameter Description**:
- `X` (np.ndarray): Test feature data
- `y` (np.ndarray): Test label data

**Return Value**: The model accuracy (a floating - point number between 0 and 1)

**Usage Example**:
```python
accuracy = nn.evaluate(X_test, y_test)
print(f"Model accuracy: {accuracy:.2%}")
```

##### 3.4 predict() Method - Model Prediction

**Function Signature**:
```python
def predict(self, X):
```

**Parameter Description**:
- `X` (np.ndarray): Feature data to be predicted

**Return Value**: An array of prediction results, containing class labels (0: left turn, 1: right turn, 2: forward, 3: stop)

**Usage Example**:
```python
prediction = nn.predict(image_array)
print(f"Predicted action: {prediction}")
```

##### 3.5 save_model() Method - Save the Model

**Function Signature**:
```python
def save_model(self, path):
```

**Parameter Description**:
- `path` (str): The path to save the model

**Usage Example**:
```python
nn.save_model("saved_model/nn_model.xml")
```

##### 3.6 load_model() Method - Load the Model

**Function Signature**:
```python
def load_model(self, path):
```

**Parameter Description**:
- `path` (str): The path to the model file

**Usage Example**:
```python
nn.load_model("saved_model/nn_model.xml")
```

#### 4. RCControl Class - RC Car Control

**Function**: Control the movement of the RC car through the serial port.

**Class Methods**:

##### 4.1 __init__() Method - Initialization

**Function Signature**:
```python
def __init__(self, serial_port):
```

**Parameter Description**:
- `serial_port` (str): The path to the serial port device, such as "/dev/tty.usbmodem1421"

**Usage Example**:
```python
rc_car = RCControl("/dev/tty.usbmodem1421")
```

##### 4.2 steer() Method - Steering Control

**Function Signature**:
```python
def steer(self, prediction):
```

**Parameter Description**:
- `prediction` (int): The predicted action label
  - 0: Left turn
  - 1: Right turn
  - 2: Forward
  - Other: Stop

**Usage Example**:
```python
rc_car.steer(prediction)
```

##### 4.3 stop() Method - Stop Control

**Function Signature**:
```python
def stop(self):
```

**Usage Example**:
```python
rc_car.stop()
```

#### 5. DistanceToCamera Class - Distance Calculation

**Function**: Calculate the distance from the target object to the camera based on camera parameters.

**Class Methods**:

##### 5.1 __init__() Method - Initialization

**Function Signature**:
```python
def __init__(self):
```

**Usage Example**:
```python
d_to_camera = DistanceToCamera()
```

##### 5.2 calculate() Method - Distance Calculation

**Function Signature**:
```python
def calculate(self, v, h, x_shift, image):
```

**Parameter Description**:
- `v` (float): The vertical coordinate of the target point in the image
- `h` (float): The actual height of the target object (in centimeters)
- `x_shift` (int): The X - axis offset for text display
- `image` (np.ndarray): The image array for displaying distance information

**Return Value**: The calculated distance (in centimeters)

**Usage Example**:
```python
distance = d_to_camera.calculate(v_param, 5.5, 300, image)
```

#### 6. ObjectDetection Class - Object Detection

**Function**: Detect stop signs and traffic lights using a cascade classifier.

**Class Methods**:

##### 6.1 __init__() Method - Initialization

**Function Signature**:
```python
def __init__(self):
```

**Usage Example**:
```python
obj_detection = ObjectDetection()
```

##### 6.2 detect() Method - Object Detection

**Function Signature**:
```python
def detect(self, cascade_classifier, gray_image, image):
```

**Parameter Description**:
- `cascade_classifier`: An OpenCV cascade classifier object
- `gray_image` (np.ndarray): A grayscale image
- `image` (np.ndarray): A color image for drawing the detection results

**Return Value**: The Y - coordinate of the bottom of the detected object, returning 0 if no object is detected

**Usage Example**:
```python
# Load the cascade classifier
stop_cascade = cv2.CascadeClassifier("cascade_xml/stop_sign.xml")
light_cascade = cv2.CascadeClassifier("cascade_xml/traffic_light.xml")

# Detect stop signs
v_param1 = obj_detection.detect(stop_cascade, gray, image)
# Detect traffic lights
v_param2 = obj_detection.detect(light_cascade, gray, image)
```

### Detailed Description of Configuration Classes

#### 1. Server Configuration Class

**Function**: Configure the connection parameters and port settings of the network server

```python
class Server(object):
    def __init__(self, host, port1, port2):
        self.host = host          # Server host address
        self.port1 = port1        # Video stream port
        self.port2 = port2        # Sensor data port
```

**Parameter Description**:
- `host` (str): The server host address, such as "192.168.1.100"
- `port1` (int): The video stream server port, default is 8000
- `port2` (int): The sensor data server port, default is 8002

**Usage Example**:
```python
# Create a server instance
server = Server("192.168.1.100", 8000, 8002)
server.start()
```

#### 2. VideoStreamHandler Configuration Class

**Function**: Configure the parameters and threshold settings of the video stream processor

```python
class VideoStreamHandler(socketserver.StreamRequestHandler):
    # Object height parameters (manually measured)
    h1 = 5.5  # Stop sign height (cm)
    h2 = 5.5  # Traffic light height (cm)
    
    # Distance threshold configuration
    d_sensor_thresh = 30      # Ultrasonic sensor stop threshold (cm)
    d_stop_light_thresh = 25  # Stop sign and traffic light stop threshold (cm)
    
    # Time control parameters
    stop_start = 0            # Stop start time
    stop_finish = 0           # Stop finish time
    stop_time = 0             # Stop duration
    drive_time_after_stop = 0 # Driving time after stop
```

**Configuration Parameter Description**:
- `h1`, `h2` (float): The actual height of the target objects, used for distance calculation
- `d_sensor_thresh` (int): The stop distance when the ultrasonic sensor detects an obstacle
- `d_stop_light_thresh` (int): The stop distance for stop signs and traffic lights
- `stop_start`, `stop_finish` (int): Records of stop timestamps
- `stop_time` (float): The calculated stop duration
- `drive_time_after_stop` (float): The driving time after stopping

#### 3. CollectTrainingData Configuration Class

**Function**: Configure the network and serial port parameters of the training data collector

```python
class CollectTrainingData(object):
    def __init__(self, host, port, serial_port, input_size):
        self.server_socket = socket.socket()
        self.server_socket.bind((host, port))
        self.server_socket.listen(0)
        
        # Serial port connection configuration
        self.ser = serial.Serial(serial_port, 115200, timeout=1)
        
        # Input size configuration
        self.input_size = input_size
        
        # Label matrix configuration
        self.k = np.zeros((4, 4), 'float')
        for i in range(4):
            self.k[i, i] = 1
```

**Parameter Description**:
- `host` (str): The host address of the data collection server
- `port` (int): The port of the data collection server
- `serial_port` (str): The path to the Arduino serial port device
- `input_size` (int): The size of the input image (number of pixels)
- `k` (np.ndarray): A 4x4 label matrix for one - hot encoding

#### 4. RCControl Configuration Class

**Function**: Configure the serial communication parameters of the RC car controller

```python
class RCControl(object):
    def __init__(self, serial_port):
        self.serial_port = serial.Serial(serial_port, 115200, timeout=1)
```

**Parameter Description**:
- `serial_port` (str): The path to the serial port device, such as "/dev/tty.usbmodem1421"
- `115200` (int): The baud rate setting
- `timeout = 1` (int): The timeout for serial communication (in seconds)

#### 5. DistanceToCamera Configuration Class

**Function**: Configure the camera parameters of the camera distance calculator

```python
class DistanceToCamera(object):
    def __init__(self):
        # Camera parameters (obtained through manual measurement and calibration)
        self.alpha = 8.0 * math.pi / 180    # Camera viewing angle (in radians)
        self.v0 = 119.865631204             # Camera matrix parameter v0
        self.ay = 332.262498472             # Camera matrix parameter ay
```

**Parameter Description**:
- `alpha` (float): The viewing angle parameter of the camera, used for distance calculation
- `v0` (float): The vertical offset parameter of the camera intrinsic matrix
- `ay` (float): The focal length parameter of the camera intrinsic matrix

#### 6. ObjectDetection Configuration Class

**Function**: Configure the status flags of the object detector

```python
class ObjectDetection(object):
    def __init__(self):
        # Traffic light status flags
        self.red_light = False      # Red light detection flag
        self.green_light = False    # Green light detection flag
        self.yellow_light = False   # Yellow light detection flag
```

**Parameter Description**:
- `red_light` (bool): The red light detection status
- `green_light` (bool): The green light detection status
- `yellow_light` (bool): The yellow light detection status

#### 7. Cascade Classifier Configuration

**Function**: Configure the parameters of the cascade classifier for object detection

```python
# Cascade classifier configuration
stop_cascade = cv2.CascadeClassifier("cascade_xml/stop_sign.xml")
light_cascade = cv2.CascadeClassifier("cascade_xml/traffic_light.xml")

# Detection parameter configuration
cascade_obj = cascade_classifier.detectMultiScale(
    gray_image,
    scaleFactor=1.1,      # Image scaling factor
    minNeighbors=5,       # Minimum number of neighbors
    minSize=(30, 30)      # Minimum detection size
)
```

**Parameter Description**:
- `scaleFactor` (float): The scaling factor of the image pyramid, affecting the detection speed
- `minNeighbors` (int): The minimum number of neighbors for candidate detection boxes, affecting the detection accuracy
- `minSize` (tuple): The minimum size of the detected target (width, height)

### Actual Usage Modes

#### Basic Usage

```python
from model import NeuralNetwork, load_data
from rc_driver_helper import RCControl, DistanceToCamera, ObjectDetection

# Simple model training and prediction
nn = NeuralNetwork()
nn.create(np.int32([76800, 32, 4]))
nn.train(X_train, y_train)
prediction = nn.predict(image_array)
```

#### Full Autonomous Driving Mode

```185:189:computer/rc_driver.py
if __name__ == '__main__':
    h, p1, p2 = "192.168.1.100", 8000, 8002

    ts = Server(h, p1, p2)
    ts.start()
```

The system will automatically handle:
- Real-time video stream analysis
- Neural network prediction
- Object detection (stop signs, traffic lights)
- Distance measurement
- RC car control

#### Data Collection Mode

```python
if __name__ == '__main__':
    # host, port
    h, p = "192.168.1.100", 8000

    # serial port
    sp = "/dev/tty.usbmodem1421"

    # vector size, half of the image
    s = 120 * 320

    ctd = CollectTrainingData(h, p, sp, s)
    ctd.collect()
```

Manually drive to collect data:
- Use the arrow keys to control the RC car
- The system automatically saves the images and corresponding control instructions
- Press 'q' or 'x' to end the collection

#### Model Training Mode

**Example usage (no dedicated script in the codebase)**:

```python
from model import NeuralNetwork, load_data
import numpy as np

# Load training data
X_train, X_test, y_train, y_test = load_data(76800, "training_data/*.npz")

# Create a neural network
nn = NeuralNetwork()
nn.create(np.int32([76800, 32, 4]))

# Train the model
nn.train(X_train, y_train)

# Evaluate the model
accuracy = nn.evaluate(X_test, y_test)
print(f"Model accuracy: {accuracy:.2%}")

# Save the model
nn.save_model("saved_model/nn_model.xml")
```

#### Object Detection Mode

**Object detection is integrated in `VideoStreamHandler.handle()` method**

See the actual implementation in:
- **Object Detection**: `rc_driver_helper.py` lines 64-98 (`ObjectDetection` class)
- **Distance Calculation**: `rc_driver_helper.py` lines 32-45 (`DistanceToCamera` class)
- **Usage in video stream**: `rc_driver.py` lines 100-149 (`VideoStreamHandler.handle()` method)

The system automatically detects stop signs and traffic lights in the video stream and calculates their distances.

#### Hardware Control Mode

**The `RCControl` class provides hardware control interface**

```python
class RCControl(object):

    def __init__(self, serial_port):
        # Initialize serial port
        self.serial_port = serial_port
        self.ser = serial.Serial(self.serial_port, 115200, timeout=1)

    def steer(self, prediction):
        if prediction == 2:
            self.ser.write(b'1')
            print("Forward")
        elif prediction == 0:
            self.ser.write(b'2')
            print("Left")
        elif prediction == 1:
            self.ser.write(b'3')
            print("Right")

    def stop(self):
        self.ser.write(b'4')
```

Usage: `rc_car = RCControl("/dev/tty.usbmodem1421")` then call `rc_car.steer(prediction)` or `rc_car.stop()`

### Supported Function Types

- **Image Processing**: Real - time video stream processing, image pre - processing, ROI extraction
- **Machine Learning**: Neural network training, model prediction, data collection
- **Object Detection**: Stop sign detection, traffic light recognition, distance measurement
- **Hardware Control**: RC car motion control, serial communication, sensor data fusion
- **Network Communication**: Video stream transmission, sensor data transmission, multi - thread processing
- **Safety Control**: Collision avoidance, emergency stop, safety distance judgment

### Error Handling

The system provides a complete error handling mechanism:
- **Hardware connection protection**: Detect the serial port connection status and handle connection failures
- **Network communication fault tolerance**: Handle network disconnections, data loss, and other exceptions
- **Model loading protection**: Check the existence of the model file and handle loading failures
- **Sensor data verification**: Verify the validity of sensor data and handle abnormal values
- **Image processing exceptions**: Handle image format errors, decoding failures, and other situations


## Detailed Implementation Nodes of Functions

### Node 1: Neural Network Training

**Function Description**: A neural network model training system based on OpenCV, realizing end - to - end autonomous driving decision learning. It supports image data pre - processing, model architecture configuration, training process monitoring, and model persistence.

**Core Algorithms**:
- Multi - layer perceptron (MLP) architecture design
- Back - propagation training algorithm
- Sigmoid activation function
- Data standardization and normalization
- Training and validation set splitting

**Input - Output Example**:

```python
from model import NeuralNetwork, load_data
import numpy as np

# Data loading and pre - processing
X_train, X_test, y_train, y_test = load_data(76800, "training_data/*.npz")
print(f"Training data shape: {X_train.shape}")
print(f"Label data shape: {y_train.shape}")

# Neural network model creation
nn = NeuralNetwork()
nn.create([76800, 32, 4])  # Input layer 76800, hidden layer 32, output layer 4

# Model training
nn.train(X_train, y_train)

# Model evaluation
accuracy = nn.evaluate(X_test, y_test)
print(f"Model accuracy: {accuracy:.2%}")

# Model saving
nn.save_model("saved_model/nn_model.xml")

# Model prediction
prediction = nn.predict(test_image_array)
print(f"Predicted action: {prediction}")  # 0: Left turn, 1: Right turn, 2: Forward, 3: Stop
```

### Node 2: Real - time Video Stream Processing

**Function Description**: Process the real - time video stream from the Raspberry Pi camera, realizing JPEG format decoding, image pre - processing, ROI extraction, and frame buffer management. It supports low - latency video data transmission and processing.

**Core Algorithms**:
- JPEG stream parsing and frame extraction
- Image format conversion and pre - processing
- ROI (Region of Interest) extraction
- Frame buffer management
- Real - time display processing


```python
stream_bytes = b' '
while True:
    stream_bytes += self.rfile.read(1024)
    first = stream_bytes.find(b'\xff\xd8')
    last = stream_bytes.find(b'\xff\xd9')
    if first != -1 and last != -1:
        jpg = stream_bytes[first:last + 2]
        stream_bytes = stream_bytes[last + 2:]
        gray = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        image = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)

        # lower half of the image
        height, width = gray.shape
        roi = gray[int(height/2):height, :]
        
        cv2.imshow('image', image)
        
        # reshape image
        image_array = roi.reshape(1, int(height/2) * width).astype(np.float32)
```

### Node 3: Object Detection

**Function Description**: Use a Haar cascade classifier to achieve real - time detection of stop signs and traffic lights. It supports multi - scale detection, bounding box positioning, and detection confidence evaluation, providing accurate detection results for subsequent object recognition.

**Core Algorithms**:
- Haar feature detection
- Cascade classifier application
- Multi - scale detection algorithm
- Detection box positioning
- Confidence evaluation

```python
# object detection
v_param1 = self.obj_detection.detect(self.stop_cascade, gray, image)
v_param2 = self.obj_detection.detect(self.light_cascade, gray, image)

# distance measurement
if v_param1 > 0 or v_param2 > 0:
    d1 = self.d_to_camera.calculate(v_param1, self.h1, 300, image)
    d2 = self.d_to_camera.calculate(v_param2, self.h2, 100, image)
    self.d_stop_sign = d1
    self.d_light = d2
```

```python
# detection
cascade_obj = cascade_classifier.detectMultiScale(
    gray_image,
    scaleFactor=1.1,
    minNeighbors=5,
    minSize=(30, 30))

# draw a rectangle around the objects
for (x_pos, y_pos, width, height) in cascade_obj:
    cv2.rectangle(image, (x_pos + 5, y_pos + 5), (x_pos + width - 5, y_pos + height - 5), (255, 255, 255), 2)
    v = y_pos + height - 5
```

### Node 4: Object Recognition

**Function Description**: Based on the detection results, perform object type recognition and state judgment. Conduct color recognition and state analysis on traffic lights, and confirm stop signs, providing accurate recognition information for autonomous driving decisions.

**Core Algorithms**:
- Image region extraction (ROI)
- Color space analysis
- Brightness threshold judgment
- State classification algorithm
- Recognition result verification


```python
# stop sign
if width / height == 1:
    cv2.putText(image, 'STOP', (x_pos, y_pos - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

# traffic lights
else:
    roi = gray_image[y_pos + 10:y_pos + height - 10, x_pos + 10:x_pos + width - 10]
    mask = cv2.GaussianBlur(roi, (25, 25), 0)
    (minVal, maxVal, minLoc, maxLoc) = cv2.minMaxLoc(mask)

    # check if light is on
    if maxVal - minVal > threshold:
        cv2.circle(roi, maxLoc, 5, (255, 0, 0), 2)

        # Red light
        if 1.0 / 8 * (height - 30) < maxLoc[1] < 4.0 / 8 * (height - 30):
            cv2.putText(image, 'Red', (x_pos + 5, y_pos - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
            self.red_light = True

        # Green light
        elif 5.5 / 8 * (height - 30) < maxLoc[1] < height - 30:
            cv2.putText(image, 'Green', (x_pos + 5, y_pos - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0),2)
            self.green_light = True
```
### Node 5: Distance Measurement

**Function Description**: Measure the position information of the target object in the image and calculate distance based on camera parameters. Uses camera intrinsic matrix and triangulation principle to compute distance from detected objects.

**Core Algorithms**:
- Camera geometric model
- Triangulation principle
- Distance calculation formula
- Camera intrinsic matrix parameters


```python
class DistanceToCamera(object):

    def __init__(self):
        # camera params
        self.alpha = 8.0 * math.pi / 180    # degree measured manually
        self.v0 = 119.865631204             # from camera matrix
        self.ay = 332.262498472             # from camera matrix

    def calculate(self, v, h, x_shift, image):
        # compute and return the distance from the target point to the camera
        d = h / math.tan(self.alpha + math.atan((v - self.v0) / self.ay))
        if d > 0:
            cv2.putText(image, "%.1fcm" % d,
                        (image.shape[1] - x_shift, image.shape[0] - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        return d
```

Usage example:

```python
if v_param1 > 0 or v_param2 > 0:
    d1 = self.d_to_camera.calculate(v_param1, self.h1, 300, image)
    d2 = self.d_to_camera.calculate(v_param2, self.h2, 100, image)
    self.d_stop_sign = d1
    self.d_light = d2
```

### Node 6: Autonomous Driving Decision Control

**Function Description**: Based on neural network prediction, object detection, and sensor data, implement intelligent autonomous driving decision control. Support multiple stop conditions and safety control mechanisms.

**Core Algorithms**:
- Multi-sensor data fusion
- Decision logic control
- Safety threshold judgment
- Time control mechanism
- Emergency stop processing


```python
# neural network makes prediction
prediction = self.nn.predict(image_array)

# stop conditions
if sensor_data and int(sensor_data) < self.d_sensor_thresh:
    print("Stop, obstacle in front")
    self.rc_car.stop()
    sensor_data = None

elif 0 < self.d_stop_sign < self.d_stop_light_thresh and stop_sign_active:
    print("Stop sign ahead")
    self.rc_car.stop()

    # stop for 5 seconds
    if stop_flag is False:
        self.stop_start = cv2.getTickCount()
        stop_flag = True
    self.stop_finish = cv2.getTickCount()
    
    self.stop_time = (self.stop_finish - self.stop_start) / cv2.getTickFrequency()
    print("Stop time: %.2fs" % self.stop_time)
    
    # 5 seconds later, continue driving
    if self.stop_time > 5:
        print("Waited for 5 seconds")
        stop_flag = False
        stop_sign_active = False

elif 0 < self.d_light < self.d_stop_light_thresh:
    if self.obj_detection.red_light:
        print("Red light")
        self.rc_car.stop()
    elif self.obj_detection.green_light:
        print("Green light")
        pass
    elif self.obj_detection.yellow_light:
        print("Yellow light flashing")
        pass
    
    self.d_light = self.d_stop_light_thresh
    self.obj_detection.red_light = False
    self.obj_detection.green_light = False
    self.obj_detection.yellow_light = False

else:
    self.rc_car.steer(prediction)
    self.stop_start = cv2.getTickCount()
    self.d_stop_sign = self.d_stop_light_thresh
```

### Node 7: Hardware Control Interface

**Function Description**: Control the hardware devices of the RC car through serial communication, achieving precise motion control. Support multiple control instructions and real-time response.

**Core Algorithms**:
- Serial communication protocol
- Control instruction encoding
- Real-time response processing


```python
class RCControl(object):

    def __init__(self, serial_port):
        self.serial_port = serial.Serial(serial_port, 115200, timeout=1)

    def steer(self, prediction):
        if prediction == 2:
            self.serial_port.write(chr(1).encode())
            print("Forward")
        elif prediction == 0:
            self.serial_port.write(chr(7).encode())
            print("Left")
        elif prediction == 1:
            self.serial_port.write(chr(6).encode())
            print("Right")
        else:
            self.stop()

    def stop(self):
        self.serial_port.write(chr(0).encode())
```

**Control Command Mapping**:
- `prediction == 0`: Left turn (send `chr(7)`)
- `prediction == 1`: Right turn (send `chr(6)`)
- `prediction == 2`: Forward (send `chr(1)`)
- Other: Stop (send `chr(0)`)
