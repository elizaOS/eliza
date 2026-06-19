## Introduction and Goals of the PyTorch Grad-CAM Project

PyTorch Grad-CAM is a Python library **for interpretable AI in computer vision** that provides a variety of state-of-the-art pixel attribution methods for the visual interpretation of deep neural networks. This tool performs excellently in tasks such as image classification, object detection, and semantic segmentation, and can achieve "the most comprehensive collection of CAM methods and the best visualization effects." Its core functions include: implementation of multiple CAM algorithms (GradCAM, HiResCAM, ScoreCAM, AblationCAM, EigenCAM, etc.), **support for multiple architectures** (supporting mainstream networks such as ResNet, VGG, Vision Transformer, and Swin Transformer), and adaptation to different tasks such as classification, detection, and segmentation. In short, PyTorch Grad-CAM is committed to providing a complete toolkit for interpretable computer vision to diagnose model prediction results and help researchers and developers understand the decision-making process of deep learning models (for example, generating class activation maps through the GradCAM method and providing more model-faithful explanations through HiResCAM).

## Natural Language Instruction (Prompt)

Please create a Python project named PyTorch Grad-CAM to implement a toolkit for interpretable AI in computer vision. The project should include the following functions:

1. **Implementation of Multiple CAM Algorithms**: Implement multiple class activation map methods, including GradCAM (gradient-based class activation map), HiResCAM (high-resolution CAM), ScoreCAM (score-based CAM), AblationCAM (ablation-based CAM), EigenCAM (eigen-based class activation map), GradCAM++ (improved GradCAM), XGradCAM (normalized gradient-based CAM), LayerCAM (layer-based CAM), FullGrad (full gradient method), KPCA_CAM (kernel principal component analysis-based CAM), ShapleyCAM (Shapley value-based CAM), FinerCAM (fine-grained CAM), FEM (feature enhancement method), etc. Each method should provide an independent class implementation, inheriting from the BaseCAM base class.

2. **Support for Multiple Architecture Models**: Implement functions that can adapt to different deep learning architectures, including CNN networks (ResNet, VGG, DenseNet, etc.), Vision Transformer (ViT, DeiT, etc.), Swin Transformer, object detection networks (Faster R-CNN, YOLO, etc.), semantic segmentation networks, etc. A reshape_transform parameter should be provided to handle the shape transformation of activation maps for different architectures.

3. **Adaptation to Multiple Task Objectives**: Provide specialized objective functions for different computer vision tasks, including image classification (ClassifierOutputTarget, ClassifierOutputSoftmaxTarget), object detection (FasterRCNNBoxScoreTarget), semantic segmentation (SemanticSegmentationTarget), embedding similarity (EmbeddingSimilarityTarget), etc. Each objective function should implement the __call__ method to handle model outputs.

4. **Image Processing and Visualization Tools**: Provide complete image preprocessing and postprocessing functions, including the preprocess_image() function for image standardization, the show_cam_on_image() function for overlaying the CAM on the original image, the deprocess_image() function for image inverse standardization, the scale_cam_image() function for CAM size adjustment, etc. Support RGB/BGR format conversion and multiple color maps.

5. **Evaluation Metrics and Testing Framework**: Implement multiple CAM evaluation metrics, including ROAD (Remove and Debias) metrics (ROADMostRelevantFirst, ROADLeastRelevantFirst, ROADCombined), confidence perturbation metrics (PerturbationConfidenceMetric), multi-image CAM metrics (CamMultImageConfidenceChange), etc. Provide a complete pytest testing framework, including 178 test cases covering all CAM methods and different configurations.

6. **Core File Requirements**: The project must include a complete pyproject.toml file, which should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as torch>=1.7.1, torchvision>=0.8.2, opencv-python>=4.5.0, matplotlib>=3.3.0, scikit-learn>=0.24.0, numpy>=1.19.0, scipy>=1.5.0, ttach>=1.0.0, tqdm>=4.50.0, pytest>=6.0.0, psutil>=5.8.0, timm>=0.4.0). The pyproject.toml file can verify whether all functional modules work properly. At the same time, pytorch_grad_cam/__init__.py is required as a unified API entry, importing all CAM classes from each CAM module, exporting core classes and functions such as AGradCAM, ScoreCAM, GradCAMPlusPlus, AblationCAM, XGradCAM, EigenCAM, EigenGradCAM, LayerCAM, FullGrad, KPCA_CAM, and providing version information, enabling users to access all major functions through simple statements like "from pytorch_grad_cam import **/from pytorch_grad_cam.utils import **". In base_cam.py, there needs to be a BaseCAM base class to define the common interface for all CAM methods, including the __call__() method for performing CAM calculations, the forward() method for forward propagation, the get_cam_weights() method for obtaining CAM weights, etc.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.18

### Core Dependency Library Versions

```Plain
# Deep learning framework
torch>=1.7.1                      # PyTorch deep learning framework
torchvision>=0.8.2                # PyTorch computer vision library

# Image processing and visualization
opencv-python>=4.5.0              # OpenCV computer vision library
Pillow>=8.0.0                     # Python image processing library
matplotlib>=3.3.0                 # Data visualization library

# Numerical computation and data processing
numpy>=1.19.0                     # Fundamental numerical computation library
scipy>=1.5.0                      # Scientific computation library
scikit-learn>=0.24.0              # Machine learning library

# Enhancement and transformation
ttach>=1.0.0                      # Test-time augmentation library
tqdm>=4.50.0                      # Progress bar library

# Testing and monitoring
pytest>=6.0.0                     # Unit testing framework
psutil>=5.8.0                     # System and process monitoring library

# Optional dependencies (for specific examples)
timm>=0.4.0                       # Pretrained model library
```

## PyTorch Grad-CAM Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitattributes
├── .gitignore
├── LICENSE
├── MANIFEST.in
├── README.md
├── cam.py
├── pyproject.toml
├── pytorch_grad_cam
│   ├── __init__.py
│   ├── ablation_cam.py
│   ├── ablation_cam_multilayer.py
│   ├── ablation_layer.py
│   ├── activations_and_gradients.py
│   ├── base_cam.py
│   ├── eigen_cam.py
│   ├── eigen_grad_cam.py
│   ├── feature_factorization
│   │   ├── __init__.py
│   │   ├── deep_feature_factorization.py
│   ├── fem.py
│   ├── finer_cam.py
│   ├── fullgrad_cam.py
│   ├── grad_cam.py
│   ├── grad_cam_elementwise.py
│   ├── grad_cam_plusplus.py
│   ├── guided_backprop.py
│   ├── hirescam.py
│   ├── kpca_cam.py
│   ├── layer_cam.py
│   ├── metrics
│   │   ├── __init__.py
│   │   ├── cam_mult_image.py
│   │   ├── perturbation_confidence.py
│   │   ├── road.py
│   ├── random_cam.py
│   ├── score_cam.py
│   ├── shapley_cam.py
│   ├── sobel_cam.py
│   ├── utils
│   │   ├── __init__.py
│   │   ├── find_layers.py
│   │   ├── image.py
│   │   ├── model_targets.py
│   │   ├── reshape_transforms.py
│   │   ├── svd_on_activations.py
│   ├── xgrad_cam.py
└── usage_examples
    ├── clip_example.py
    ├── swinT_example.py
    └── vit_example.py

```

## API Usage Guide

### Core APIs

#### 1. Module Import

```python
from pytorch_grad_cam import GradCAM, ScoreCAM, GradCAMPlusPlus, AblationCAM, XGradCAM, EigenCAM, 
    EigenGradCAM, LayerCAM, FullGrad,KPCA_CAM
from pytorch_grad_cam.utils.image import show_cam_on_image, preprocess_image
from pytorch_grad_cam.utils.model_targets import ClassifierOutputTarget
)
```

#### 2. BaseCAM Base Class - Common Interface for CAM Methods

**Function**: The base class for all CAM methods, defining common interfaces and implementations.

**Class Signature**:
```python
class BaseCAM:
    def __init__(
        self,
        model: torch.nn.Module,
        target_layers: List[torch.nn.Module],
        reshape_transform: Callable = None,
        compute_input_gradient: bool = False,
        uses_gradients: bool = True,
        tta_transforms: Optional[tta.Compose] = None,
        detach: bool = True,
    ) -> None:
```

**Parameter Description**:
- `model` (torch.nn.Module): The deep learning model to be interpreted.
- `target_layers` (List[torch.nn.Module]): A list of target layers for extracting activations and gradients.
- `reshape_transform` (Callable): An optional shape transformation function for handling activation maps of different architectures.
- `compute_input_gradient` (bool): Whether to compute input gradients, default is False.
- `uses_gradients` (bool): Whether to use gradients, default is True.
- `tta_transforms` (Optional[tta.Compose]): Test-time augmentation transforms, default is None.
- `detach` (bool): Whether to detach gradients, default is True.

**Main Methods**:
- `__call__(input_tensor, targets=None, aug_smooth=False, eigen_smooth=False)`: Perform CAM computation.
- `get_cam_weights()`: Get CAM weights (needs to be implemented by subclasses).
- `forward()`: Forward propagation.
- `get_cam_image()`: Generate the CAM image.

#### 3. GradCAM Class - Gradient-based Class Activation Mapping

**Function**: Implement the GradCAM algorithm to generate class activation maps by gradient-weighted activation maps.

**Class Signature**:
```python
class GradCAM(BaseCAM):
    def __init__(self, model, target_layers, reshape_transform=None):
```

**Usage Example**:
```python
# Create a GradCAM instance
cam = GradCAM(model=model, target_layers=[model.layer4[-1]])

# Generate CAM
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)

# Visualize the results
visualization = show_cam_on_image(rgb_img, grayscale_cam[0], use_rgb=True)
```

#### 4. ScoreCAM Class - Score-based Class Activation Mapping

**Function**: Implement the ScoreCAM algorithm, which generates class activation maps by activation map weighting without gradient computation.

**Class Signature**:
```python
class ScoreCAM(BaseCAM):
    def __init__(self, model, target_layers, reshape_transform=None):
```

**Features**:
- No gradient computation required.
- High computational cost.
- Supports batch processing.

#### 5. AblationCAM Class - Ablation-based Class Activation Mapping

**Function**: Implement the AblationCAM algorithm, which generates class activation maps by gradually ablating activation maps.

**Class Signature**:
```python
class AblationCAM(BaseCAM):
    def __init__(self, model, target_layers, reshape_transform=None, ablation_layer=None):
```

**Parameter Description**:
- `ablation_layer`: The ablation layer for controlling the ablation method of activation maps.

#### 6. Image Processing Utility Functions

**preprocess_image() Function - Image Preprocessing**

**Function**: Convert the input image to the tensor format required by the model.

**Function Signature**:
```python
def preprocess_image(
    img: np.ndarray, 
    mean=[0.5, 0.5, 0.5], 
    std=[0.5, 0.5, 0.5]
) -> torch.Tensor:
```

**Parameter Description**:
- `img` (np.ndarray): The input image in RGB format.
- `mean` (List[float]): The normalization mean, default is [0.5, 0.5, 0.5].
- `std` (List[float]): The normalization standard deviation, default is [0.5, 0.5, 0.5].

**Return Value**: The preprocessed torch.Tensor.

**show_cam_on_image() Function - CAM Visualization**

**Function**: Overlay the CAM heatmap on the original image.

**Function Signature**:
```python
def show_cam_on_image(
    img: np.ndarray,
    mask: np.ndarray,
    use_rgb: bool = False,
    colormap: int = cv2.COLORMAP_JET,
    image_weight: float = 0.5
) -> np.ndarray:
```

**Parameter Description**:
- `img` (np.ndarray): The original image in RGB or BGR format.
- `mask` (np.ndarray): The CAM heatmap.
- `use_rgb` (bool): Whether to use RGB format, default is False.
- `colormap` (int): The OpenCV color map, default is cv2.COLORMAP_JET.
- `image_weight` (float): The image weight, range [0,1], default is 0.5.

**Return Value**: The overlaid image.

#### 7. Model Target Functions

**ClassifierOutputTarget Class - Classification Output Target**

**Function**: The target function for image classification tasks.

**Class Signature**:
```python
class ClassifierOutputTarget:
    def __init__(self, category):
        self.category = category

    def __call__(self, model_output):
```

**Parameter Description**:
- `category` (int): The index of the target category.

**Usage Example**:
```python
targets = [ClassifierOutputTarget(281)]  # Target category 281
```

**SemanticSegmentationTarget Class - Semantic Segmentation Target**

**Function**: The target function for semantic segmentation tasks.

**Class Signature**:
```python
class SemanticSegmentationTarget:
    def __init__(self, category, mask):
        self.category = category
        self.mask = torch.from_numpy(mask)

    def __call__(self, model_output):
```

**Parameter Description**:
- `category` (int): The index of the target category.
- `mask` (np.ndarray): The binary spatial mask.

#### 8. Shape Transformation Functions

**vit_reshape_transform() Function - Vision Transformer Shape Transformation**

**Function**: Convert the activation maps of Vision Transformer to the standard format.

**Function Signature**:
```python
def vit_reshape_transform(tensor, height=14, width=14):
```

**Parameter Description**:
- `tensor` (torch.Tensor): The input tensor.
- `height` (int): The target height, default is 14.
- `width` (int): The target width, default is 14.

**swinT_reshape_transform() Function - Swin Transformer Shape Transformation**

**Function**: Convert the activation maps of Swin Transformer to the standard format.

**Function Signature**:
```python
def swinT_reshape_transform(tensor, height=7, width=7):
```

#### 9. Evaluation Metrics

**ROADMostRelevantFirst Class - ROAD Most Relevant First Metric**

**Function**: Implement the most relevant first version of the ROAD (Remove and Debias) evaluation metric.

**Class Signature**:
```python
class ROADMostRelevantFirst(PerturbationConfidenceMetric):
    def __init__(self, percentile=80):
```

**Parameter Description**:
- `percentile` (int): The percentile, default is 80.

**Usage Example**:
```python
metric = ROADMostRelevantFirst(percentile=75)
scores = metric(input_tensor, grayscale_cams, targets, model)
```

**ROADCombined Class - ROAD Combined Metric**

**Function**: Combine the most relevant first and least relevant first ROAD metrics.

**Class Signature**:
```python
class ROADCombined:
    def __init__(self, percentiles=[10, 20, 30, 40, 50, 60, 70, 80, 90]):
```

**Parameter Description**:
- `percentiles` (List[int]): A list of percentiles, default is [10, 20, 30, 40, 50, 60, 70, 80, 90].

### Complete Usage Example

```python
import torch
import cv2
import numpy as np
from torchvision.models import resnet50
from pytorch_grad_cam import GradCAM
from pytorch_grad_cam.utils.model_targets import ClassifierOutputTarget
from pytorch_grad_cam.utils.image import show_cam_on_image, preprocess_image

# Load the model
model = resnet50(pretrained=True)
model.eval()

# Prepare the input
img = cv2.imread('image.jpg')
input_tensor = preprocess_image(img)

# Create GradCAM
target_layers = [model.layer4[-1]]
cam = GradCAM(model=model, target_layers=target_layers)

# Set the target
targets = [ClassifierOutputTarget(281)]  # Target category 281

# Generate CAM
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)

# Visualize
visualization = show_cam_on_image(img, grayscale_cam[0], use_rgb=True)
cv2.imwrite('cam_result.jpg', visualization)
```

## Detailed Function Implementation Nodes

### Node 1: GradCAM - Gradient-weighted Class Activation Mapping

**Function Description**: Implement the gradient-based class activation mapping algorithm. Calculate the gradient of the target category with respect to the feature map, then perform global average pooling on the gradient to obtain weights, and finally multiply the weights with the activation map to get the CAM.

**Core Algorithm**:
- Gradient Calculation: Calculate the gradient of the target category output with respect to the feature map.
- Global Average Pooling: Average the gradient over the spatial dimensions.
- Weighted Activation: Multiply the weights with the activation map to get the CAM.

**Input-Output Example**:

```python
import torch
import cv2
import numpy as np
from pytorch_grad_cam import GradCAM
from pytorch_grad_cam.utils.model_targets import ClassifierOutputTarget
from pytorch_grad_cam.utils.image import preprocess_image

# Input: Image and model
img = cv2.imread("examples/both.png")
input_tensor = preprocess_image(img)  # shape: (1, 3, H, W)
model = torchvision.models.resnet18(pretrained=True)

# Create a GradCAM instance
target_layers = [model.layer4[-1]]
cam = GradCAM(model=model, target_layers=target_layers)

# Set the target category
targets = [ClassifierOutputTarget(100)]

# Generate CAM
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)
# Output: shape: (1, H, W) - Grayscale CAM heatmap

# Test and verify
assert grayscale_cam.shape[0] == input_tensor.shape[0]  # Batch dimension matches
assert grayscale_cam.shape[1:] == input_tensor.shape[2:]  # Spatial dimension matches
assert np.all(grayscale_cam >= 0)  # CAM values are non-negative
```

### Node 2: ScoreCAM - Score-weighted Class Activation Mapping

**Function Description**: Implement the score-based class activation mapping algorithm. Without gradient computation, upsample the activation map to the input size, then multiply it with the input image and perform forward propagation to calculate the contribution score of each channel.

**Core Algorithm**:
- Activation Map Upsampling: Bilinearly interpolate the feature map to the input size.
- Activation Map Normalization: Normalize the activation map to the range [0,1].
- Input Perturbation: Multiply the normalized activation map with the input image.
- Score Calculation: Perform forward propagation on the perturbed image to calculate the score.

**Input-Output Example**:

```python
from pytorch_grad_cam import ScoreCAM
import tqdm

# Create a ScoreCAM instance (no gradients required)
cam = ScoreCAM(model=model, target_layers=target_layers)

# Generate CAM (high computational cost)
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)
# Output: shape: (1, H, W) - Score-based CAM heatmap

# Test and verify
assert grayscale_cam.shape[0] == input_tensor.shape[0]
assert grayscale_cam.shape[1:] == input_tensor.shape[2:]
assert np.all(grayscale_cam >= 0) and np.all(grayscale_cam <= 1)  # Normalized range
```

### Node 3: AblationCAM - Ablation-based Class Activation Mapping

**Function Description**: Implement the ablation-based class activation mapping algorithm. Gradually set the channels of the activation map to zero and measure the degree of the target score drop to determine the importance of each channel.

**Core Algorithm**:
- Activation Map Caching: Cache the original activation map of the target layer.
- Channel Ablation: Set the channels of the activation map to zero one by one.
- Score Drop Measurement: Calculate the score drop after ablation.
- Importance Weight: Determine the channel importance based on the score drop.

**Input-Output Example**:

```python
from pytorch_grad_cam import AblationCAM
from pytorch_grad_cam.ablation_layer import AblationLayer

# Create an AblationCAM instance
ablation_layer = AblationLayer()
cam = AblationCAM(
    model=model, 
    target_layers=target_layers,
    ablation_layer=ablation_layer,
    batch_size=32,
    ratio_channels_to_ablate=1.0
)

# Generate CAM
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)
# Output: shape: (1, H, W) - Ablation-based CAM heatmap

# Test and verify
assert grayscale_cam.shape[0] == input_tensor.shape[0]
assert grayscale_cam.shape[1:] == input_tensor.shape[2:]
```

### Node 4: EigenCAM - Eigen-based Class Activation Mapping

**Function Description**: Implement the eigen-based class activation mapping algorithm. Calculate the principal components of the activation map to generate the CAM. It does not require category information and is suitable for unsupervised interpretability analysis.

**Core Algorithm**:
- Activation Map Collection: Collect the activation map of the target layer.
- Principal Component Analysis: Perform PCA dimensionality reduction on the activation map.
- Projection Calculation: Project the activation map onto the principal component space.
- CAM Generation: Use the first principal component to generate the CAM.

**Input-Output Example**:

```python
from pytorch_grad_cam import EigenCAM
from pytorch_grad_cam.utils.svd_on_activations import get_2d_projection

# Create an EigenCAM instance (no gradients required)
cam = EigenCAM(model=model, target_layers=target_layers)

# Generate CAM (no target category required)
grayscale_cam = cam(input_tensor=input_tensor, targets=None)
# Output: shape: (1, H, W) - Principal component-based CAM heatmap

# Test and verify
assert grayscale_cam.shape[0] == input_tensor.shape[0]
assert grayscale_cam.shape[1:] == input_tensor.shape[2:]
```

### Node 5: Image Preprocessing and Normalization

**Function Description**: Convert the input image to the standardized tensor format required by the deep learning model, including resizing, normalization, and tensor conversion.

**Core Algorithm**:
- Image Copying: Avoid modifying the original image.
- Tensor Conversion: Convert the numpy array to a torch.Tensor.
- Normalization: Standardize using the specified mean and standard deviation.
- Dimension Expansion: Add the batch dimension.

**Input-Output Example**:

```python
from pytorch_grad_cam.utils.image import preprocess_image

# Input: RGB image
img = cv2.imread("examples/both.png")  # shape: (H, W, 3)
img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)  # Convert BGR to RGB

# Image preprocessing
input_tensor = preprocess_image(
    img=img,
    mean=[0.5, 0.5, 0.5],  # Normalization mean
    std=[0.5, 0.5, 0.5]    # Normalization standard deviation
)
# Output: shape: (1, 3, H, W) - Standardized tensor

# Test and verify
assert input_tensor.shape[0] == 1  # Batch dimension
assert input_tensor.shape[1] == 3  # Channel dimension
assert torch.is_tensor(input_tensor)  # Tensor type
assert input_tensor.dtype == torch.float32  # Floating-point type
```

### Node 6: CAM Heatmap Visualization

**Function Description**: Overlay the CAM heatmap on the original image to generate a visual interpretability result, supporting multiple color maps and transparency control.

**Core Algorithm**:
- Heatmap Generation: Convert the CAM to a color heatmap.
- Color Mapping: Apply the OpenCV color map (default is JET).
- Image Overlay: Overlay the heatmap with the original image according to the weight.
- Format Conversion: Support RGB/BGR format conversion.

**Input-Output Example**:

```python
from pytorch_grad_cam.utils.image import show_cam_on_image

# Input: Original image and CAM heatmap
img = cv2.imread("examples/both.png")  # shape: (H, W, 3)
grayscale_cam = cam(input_tensor=input_tensor, targets=targets)[0]  # shape: (H, W)

# CAM visualization
visualization = show_cam_on_image(
    img=img,
    mask=grayscale_cam,
    use_rgb=False,  # BGR format
    colormap=cv2.COLORMAP_JET,  # Color map
    image_weight=0.5  # Image weight
)
# Output: shape: (H, W, 3) - Overlaid visualization image

# Test and verify
assert visualization.shape == img.shape  # Size matches
assert visualization.dtype == np.uint8  # 8-bit unsigned integer
assert np.all(visualization >= 0) and np.all(visualization <= 255)  # Pixel value range
```

### Node 7: Multi-Architecture Model Adaptation

**Function Description**: Support CAM generation for different deep learning architectures, including CNN, Vision Transformer, Swin Transformer, etc. Process the activation map shapes of different architectures through the reshape_transform function.

**Core Algorithm**:
- Architecture Detection: Identify the model architecture type.
- Shape Transformation: Convert the activation map to the standard format.
- Layer Selection: Automatically select the appropriate target layer.
- Dimension Handling: Handle activation maps of different dimensions.

**Input-Output Example**:

```python
from pytorch_grad_cam.utils.reshape_transforms import fasterrcnn_reshape_transform, vit_reshape_transform, swinT_reshape_transform

# Vision Transformer adaptation
def fasterrcnn_reshape_transform(x):
    target_size = x['pool'].size()[-2:]
    activations = []
    for key, value in x.items():
        activations.append(
            torch.nn.functional.interpolate(
                torch.abs(value),
                target_size,
                mode='bilinear'))
    activations = torch.cat(activations, axis=1)
    return activations


def swinT_reshape_transform(tensor, height=7, width=7):
    result = tensor.reshape(tensor.size(0),
                            height, width, tensor.size(2))

    # Bring the channels to the first dimension,
    # like in CNNs.
    result = result.transpose(2, 3).transpose(1, 2)
    return result


def vit_reshape_transform(tensor, height=14, width=14):
    result = tensor[:, 1:, :].reshape(tensor.size(0),
                                      height, width, tensor.size(2))

    # Bring the channels to the first dimension,
    # like in CNNs.
    result = result.transpose(2, 3).transpose(1, 2)
    return result
```
