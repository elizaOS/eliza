---
name: image_editing
description: Comprehensive command-line tools for modifying and manipulating images, such as resize, blur, crop, flip, and many more.
license: Proprietary. LICENSE.txt has complete terms
---

# Command-line Tools: Convert

## Overview

This guide covers essential image processing operations using ImageMagick, a collection of command-line tools that can be applied to modify and manipulate images. With this toolkit, you can edit images in batch on Linux command-line.


## Image Operations

Use the `convert` command to resize an image, blur, crop, despeckle, dither, draw on, flip, join, re-sample, and much more.

Example Usage
We list a few examples of the command here to illustrate its usefulness and ease of use. To get started, let's reduce the size of our rose:

```
convert -resize 50% rose.jpg
```
You can resize all your JPEG images in a folder to a maximum dimension of 256x256 with this command:

```
convert -resize 256x256 *.jpg
```

Finally, we convert all our PNG images in a folder to the JPEG format:

```
convert -format jpg *.png
```

Here image files 1.png, 2.png, etc., are left untouched and files 1.jpg, 2.jpg, etc., are created. They are copies of their respective PNG images except are stored in the JPEG image format.

Useful image operations and their corresponding command:

`-auto-orient`
Adjusts an image so that its orientation is suitable for viewing (i.e. top-left orientation). This operator reads and resets the EXIF image profile setting 'Orientation' and then performs the appropriate 90 degree rotation on the image to orient the image, for correct viewing.


`-background <color>`
Set the background color. The color is specified using the format described under the -fill option. The default background color (if none is specified or found in the image) is white.


`-blend <geometry>`
Blend an image into another by the given absolute value or percent. Blend will average the images together ('plus') according to the percentages given and each pixels transparency. If only a single percentage value is given it sets the weight of the composite or 'source' image, while the background image is weighted by the exact opposite amount. That is a -blend 30% merges 30% of the 'source' image with 70% of the 'destination' image. Thus it is equivalent to -blend 30x70%.


`-blue-shift <factor>`
Simulate a scene at nighttime in the moonlight. Start with a factor of 1.5


`-blur radius`
`-blur radius{xsigma}`
Reduce image noise and reduce detail levels. Convolve the image with a Gaussian or normal distribution using the given Sigma value. The formula is:
$$
G(u, v) = \frac{1}{2\pi\sigma^2}e^{-(u^2+v^2)/(2\sigma^2)}
$$
The sigma value is the important argument, and determines the actual amount of blurring that will take place.


`-bordercolor color`
Set the border color. The color is specified using the format described under the -fill option. The default border color is #DFDFDF, this shade of gray.

`-border <value%>`
Surround the image with a border of color. value % of width is added to left/right and value % of height is added to top/bottom

`-brightness-contrast brightness`
`-brightness-contrast brightness{xcontrast}{%}`
Adjust the brightness and/or contrast of the image. Brightness and Contrast values apply changes to the input image. They are not absolute settings. A brightness or contrast value of zero means no change. The range of values is -100 to +100 on each. Positive values increase the brightness or contrast and negative values decrease the brightness or contrast. To control only contrast, set the `brightness=0`. To control only brightness, set `contrast=0` or just leave it off. You may also use `-channel` to control which channels to apply the brightness and/or contrast change. The default is to apply the same transformation to all channels.

`-channel type`
Specify those image color channels to which subsequent operators are limited. Choose from: Red, Green, Blue, Alpha, Gray, Cyan, Magenta, Yellow, Black, Opacity, Index, RGB, RGBA, CMYK, or CMYKA.

`-contrast`
Enhance or reduce the image contrast.

`-colorspace value`
Set the image colorspace.


## Dependencies

Required dependencies (install if not available):

- convert: Run `sudo apt install imagemagick` to install. After that, you can use `convert` command.
