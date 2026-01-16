use crate::Monitor;
use base64::{engine::general_purpose, Engine};
use image::imageops::FilterType;
use image::{ImageBuffer, ImageFormat, Rgba};
use std::io::{Cursor, Seek, Write};

/// Default maximum dimension for screenshot resizing (width or height)
pub const DEFAULT_MAX_DIMENSION: u32 = 1920;

/// Holds the screenshot data
#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    /// Raw image data in BGRA format (Windows) or RGBA format
    pub image_data: Vec<u8>,
    /// Width of the image
    pub width: u32,
    /// Height of the image
    pub height: u32,
    /// Monitor information if captured from a specific monitor
    pub monitor: Option<Monitor>,
}

impl ScreenshotResult {
    /// Encodes the screenshot data to the specified format and writes it to the provided writer.
    ///
    /// # Arguments
    ///
    /// * `writer` - A mutable reference to a writer (e.g., `Cursor<Vec<u8>>`).
    /// * `format` - The image format to encode to.
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on success, or an error if encoding fails.
    pub fn write_to<W: Write + Seek>(
        &self,
        writer: &mut W,
        format: ImageFormat,
    ) -> Result<(), image::ImageError> {
        use image::ImageEncoder;
        match format {
            ImageFormat::Png => {
                let encoder = image::codecs::png::PngEncoder::new(writer);
                encoder.write_image(
                    &self.image_data,
                    self.width,
                    self.height,
                    image::ExtendedColorType::Rgba8,
                )
            }
            // Add other formats as needed, or use DynamicImage for more generic support
            _ => {
                // For other formats, we can construct a DynamicImage and save it
                // This involves copying data, so it might be slightly less efficient
                let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                    self.width,
                    self.height,
                    self.image_data.clone(),
                )
                .ok_or(image::ImageError::Parameter(
                    image::error::ParameterError::from_kind(
                        image::error::ParameterErrorKind::DimensionMismatch,
                    ),
                ))?;
                let dynamic_image = image::DynamicImage::ImageRgba8(img);
                dynamic_image.write_to(writer, format)
            }
        }
    }

    /// Convert raw screenshot bytes to RGBA.
    ///
    /// - Windows captures are typically **BGRA** → we swizzle to RGBA.
    /// - macOS/Linux captures from `xcap` are typically **RGBA** → we return as-is.
    fn bgra_to_rgba(&self) -> Vec<u8> {
        #[cfg(target_os = "windows")]
        {
            return self
                .image_data
                .chunks_exact(4)
                .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]])
                .collect();
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.image_data.clone()
        }
    }

    /// Encode the screenshot as PNG bytes.
    ///
    /// Converts BGRA to RGBA and encodes as PNG format.
    ///
    /// # Returns
    /// PNG-encoded bytes
    pub fn to_png(&self) -> Result<Vec<u8>, ScreenshotError> {
        let rgba_data = self.bgra_to_rgba();
        encode_rgba_to_png(&rgba_data, self.width, self.height)
    }

    /// Encode the screenshot as PNG bytes with optional resizing.
    ///
    /// If the image exceeds `max_dimension` in either width or height,
    /// it will be resized while maintaining aspect ratio.
    ///
    /// # Arguments
    /// * `max_dimension` - Maximum width or height. If None, uses DEFAULT_MAX_DIMENSION (1920).
    ///
    /// # Returns
    /// PNG-encoded bytes (potentially resized)
    pub fn to_png_resized(&self, max_dimension: Option<u32>) -> Result<Vec<u8>, ScreenshotError> {
        let max_dim = max_dimension.unwrap_or(DEFAULT_MAX_DIMENSION);
        let rgba_data = self.bgra_to_rgba();

        // Check if resize is needed
        if self.width <= max_dim && self.height <= max_dim {
            return encode_rgba_to_png(&rgba_data, self.width, self.height);
        }

        // Calculate new dimensions maintaining aspect ratio
        let scale = (max_dim as f32 / self.width.max(self.height) as f32).min(1.0);
        let new_width = (self.width as f32 * scale).round() as u32;
        let new_height = (self.height as f32 * scale).round() as u32;

        // Create image buffer and resize
        let img = ImageBuffer::<Rgba<u8>, _>::from_raw(self.width, self.height, rgba_data)
            .ok_or_else(|| {
                ScreenshotError::ImageProcessing("Failed to create image buffer".into())
            })?;

        let resized = image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);
        encode_rgba_to_png(&resized.into_raw(), new_width, new_height)
    }

    /// Encode the screenshot as JPEG bytes with optional resizing.
    ///
    /// If the image exceeds `max_dimension` in either width or height,
    /// it will be resized while maintaining aspect ratio.
    /// JPEG is ~4x smaller than PNG for screenshots.
    ///
    /// # Arguments
    /// * `max_dimension` - Maximum width or height. If None, uses DEFAULT_MAX_DIMENSION (1920).
    /// * `quality` - JPEG quality (0-100). If None, uses DEFAULT_JPEG_QUALITY (85).
    ///
    /// # Returns
    /// JPEG-encoded bytes (potentially resized)
    pub fn to_jpeg_resized(
        &self,
        max_dimension: Option<u32>,
        quality: Option<u8>,
    ) -> Result<Vec<u8>, ScreenshotError> {
        let max_dim = max_dimension.unwrap_or(DEFAULT_MAX_DIMENSION);
        let jpeg_quality = quality.unwrap_or(DEFAULT_JPEG_QUALITY);
        let rgba_data = self.bgra_to_rgba();

        // Check if resize is needed
        if self.width <= max_dim && self.height <= max_dim {
            return encode_rgba_to_jpeg(&rgba_data, self.width, self.height, jpeg_quality);
        }

        // Calculate new dimensions maintaining aspect ratio
        let scale = (max_dim as f32 / self.width.max(self.height) as f32).min(1.0);
        let new_width = (self.width as f32 * scale).round() as u32;
        let new_height = (self.height as f32 * scale).round() as u32;

        // Create image buffer and resize
        let img = ImageBuffer::<Rgba<u8>, _>::from_raw(self.width, self.height, rgba_data)
            .ok_or_else(|| {
                ScreenshotError::ImageProcessing("Failed to create image buffer".into())
            })?;

        let resized = image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);
        encode_rgba_to_jpeg(&resized.into_raw(), new_width, new_height, jpeg_quality)
    }

    /// Encode the screenshot as base64-encoded PNG string.
    ///
    /// Useful for embedding in JSON responses or passing to LLMs.
    ///
    /// # Returns
    /// Base64-encoded PNG string
    pub fn to_base64_png(&self) -> Result<String, ScreenshotError> {
        let png_data = self.to_png()?;
        Ok(general_purpose::STANDARD.encode(&png_data))
    }

    /// Encode the screenshot as base64-encoded PNG string with optional resizing.
    ///
    /// If the image exceeds `max_dimension` in either width or height,
    /// it will be resized while maintaining aspect ratio.
    ///
    /// # Arguments
    /// * `max_dimension` - Maximum width or height. If None, uses DEFAULT_MAX_DIMENSION (1920).
    ///
    /// # Returns
    /// Base64-encoded PNG string (potentially resized)
    pub fn to_base64_png_resized(
        &self,
        max_dimension: Option<u32>,
    ) -> Result<String, ScreenshotError> {
        let png_data = self.to_png_resized(max_dimension)?;
        Ok(general_purpose::STANDARD.encode(&png_data))
    }

    /// Get the dimensions after potential resize operation.
    ///
    /// # Arguments
    /// * `max_dimension` - Maximum width or height.
    ///
    /// # Returns
    /// (width, height) after resize would be applied
    pub fn resized_dimensions(&self, max_dimension: u32) -> (u32, u32) {
        if self.width <= max_dimension && self.height <= max_dimension {
            return (self.width, self.height);
        }
        let scale = (max_dimension as f32 / self.width.max(self.height) as f32).min(1.0);
        let new_width = (self.width as f32 * scale).round() as u32;
        let new_height = (self.height as f32 * scale).round() as u32;
        (new_width, new_height)
    }

    /// Draw a cursor arrow on the screenshot at the specified position.
    ///
    /// The cursor is drawn as a red arrow with white outline, scaled based on image size.
    /// Position should be in image coordinates (not screen coordinates).
    ///
    /// # Arguments
    /// * `x` - X position in image coordinates
    /// * `y` - Y position in image coordinates
    ///
    /// # Example
    /// ```ignore
    /// let mut screenshot = element.capture()?;
    /// // Translate screen coords to image coords
    /// let img_x = cursor_screen_x - window_origin_x;
    /// let img_y = cursor_screen_y - window_origin_y;
    /// screenshot.draw_cursor(img_x, img_y);
    /// ```
    pub fn draw_cursor(&mut self, x: i32, y: i32) {
        let w = self.width as i32;
        let h = self.height as i32;

        // Check if cursor is within bounds
        if x < 0 || y < 0 || x >= w || y >= h {
            tracing::info!(
                "[draw_cursor] OUT OF BOUNDS: ({}, {}) not in {}x{}",
                x,
                y,
                w,
                h
            );
            return;
        }
        tracing::info!(
            "[draw_cursor] Drawing RED cursor at ({}, {}) on {}x{} image",
            x,
            y,
            w,
            h
        );

        // Scale cursor based on image size (base: 21px for 1000px width)
        // Min 20px, max 100px
        let scale = ((w as f32 / 1000.0) * 21.0).clamp(20.0, 100.0) / 21.0;
        let scale_i = |v: i32| -> i32 { (v as f32 * scale).round() as i32 };

        // Colors - xcap returns BGRA on Windows, but save converts to RGBA
        // So we write in BGRA: [B, G, R, A]
        // Pure red in BGRA = [0, 0, 255, 255]
        let red_color: [u8; 4] = [0, 0, 255, 255]; // Pure red (BGRA)
        let dark_color: [u8; 4] = [0, 0, 139, 255]; // Dark red outline (BGRA)
        let white_color: [u8; 4] = [255, 255, 255, 255]; // White outer outline

        // Classic arrow cursor shape - 21 pixels tall at scale 1.0
        // Each row: (y_offset, x_start, x_end) - x_end is exclusive
        let cursor_shape: &[(i32, i32, i32)] = &[
            (0, 0, 1), // tip
            (1, 0, 2),
            (2, 0, 3),
            (3, 0, 4),
            (4, 0, 5),
            (5, 0, 6),
            (6, 0, 7),
            (7, 0, 8),
            (8, 0, 9),
            (9, 0, 10),
            (10, 0, 11),
            (11, 0, 12),
            (12, 0, 6), // notch starts
            (13, 0, 5),
            (14, 0, 4),
            (15, 0, 3),
            (16, 0, 2),
            (17, 5, 7), // tail part
            (18, 6, 8),
            (19, 7, 9),
            (20, 8, 10),
        ];

        // Outline thickness (scaled)
        let outline_px = scale_i(2).max(2);

        // Helper to set pixel in BGRA format
        let set_pixel = |data: &mut [u8], px: i32, py: i32, w: i32, color: [u8; 4]| {
            if px >= 0 && px < w && py >= 0 && py < h {
                let idx = ((py * w + px) * 4) as usize;
                if idx + 3 < data.len() {
                    data[idx..idx + 4].copy_from_slice(&color);
                }
            }
        };

        // First pass: draw white outer outline (expanded shape)
        for &(dy, x_start, x_end) in cursor_shape {
            let y_base = y + scale_i(dy) - outline_px;
            let y_next = y + scale_i(dy + 1) + outline_px;

            for py in y_base..y_next {
                let x_base_start = x + scale_i(x_start) - outline_px;
                let x_base_end = x + scale_i(x_end) + outline_px;

                for px in x_base_start..x_base_end {
                    set_pixel(&mut self.image_data, px, py, w, white_color);
                }
            }
        }

        // Second pass: draw dark outline and red fill
        for &(dy, x_start, x_end) in cursor_shape {
            let y_base = y + scale_i(dy);
            let y_next = y + scale_i(dy + 1);

            for py in y_base..y_next {
                let x_base_start = x + scale_i(x_start);
                let x_base_end = x + scale_i(x_end);

                for px in x_base_start..x_base_end {
                    // Dark outline on edges
                    let is_outline = px < x_base_start + outline_px
                        || px >= x_base_end - outline_px
                        || py < y_base + outline_px
                        || py >= y_next - outline_px
                        || dy == 0
                        || dy == 20;

                    let color = if is_outline { dark_color } else { red_color };
                    set_pixel(&mut self.image_data, px, py, w, color);
                }
            }
        }
    }
}

/// Get the current mouse cursor position on screen.
/// Returns (x, y) in screen coordinates, or None if unable to get position.
#[cfg(windows)]
pub fn get_cursor_position() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point).is_ok() {
            Some((point.x, point.y))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
pub fn get_cursor_position() -> Option<(i32, i32)> {
    // Not implemented for non-Windows platforms yet
    None
}

/// Error type for screenshot operations
#[derive(Debug, thiserror::Error)]
pub enum ScreenshotError {
    #[error("Image processing error: {0}")]
    ImageProcessing(String),
    #[error("PNG encoding error: {0}")]
    PngEncoding(String),
    #[error("JPEG encoding error: {0}")]
    JpegEncoding(String),
}

/// Helper function to encode RGBA data to PNG bytes
fn encode_rgba_to_png(
    rgba_data: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<u8>, ScreenshotError> {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let mut png_data = Vec::new();
    let encoder = PngEncoder::new(Cursor::new(&mut png_data));
    encoder
        .write_image(rgba_data, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| ScreenshotError::PngEncoding(e.to_string()))?;

    Ok(png_data)
}

/// Default JPEG quality for screenshot encoding (0-100)
pub const DEFAULT_JPEG_QUALITY: u8 = 85;

/// Helper function to encode RGBA data to JPEG bytes
fn encode_rgba_to_jpeg(
    rgba_data: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, ScreenshotError> {
    use image::codecs::jpeg::JpegEncoder;
    use image::ImageEncoder;

    // Convert RGBA to RGB (drop alpha channel)
    let rgb_data: Vec<u8> = rgba_data
        .chunks_exact(4)
        .flat_map(|rgba| [rgba[0], rgba[1], rgba[2]])
        .collect();

    let mut jpeg_data = Vec::new();
    let encoder = JpegEncoder::new_with_quality(Cursor::new(&mut jpeg_data), quality);
    encoder
        .write_image(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| ScreenshotError::JpegEncoding(e.to_string()))?;

    Ok(jpeg_data)
}
