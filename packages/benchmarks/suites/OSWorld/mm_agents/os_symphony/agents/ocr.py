import re
from io import BytesIO
from typing import Tuple, List, Dict
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import pytesseract
from pytesseract import Output
import easyocr


class OCRProcessor:
    """
    OCR Processor supports Tesseract and EasyOCR
    """
    def __init__(self, use_gpu: bool = False, languages: List[str] = ['en']):
        """
        Initialize processor
        
        Args:
            use_gpu (bool): whether EasyOCR need to use gpu
            languages (List[str]): language list that EasyOCR, e.g. ['en', 'ch_sim']。
        """
        self.use_gpu = use_gpu
        self.languages = languages
        self.reader = None # lazy-load EasyOCR Reader

    def _get_easyocr_reader(self):
        if self.reader is None:
            print(f"Loading EasyOCR model (GPU={self.use_gpu})...")
            self.reader = easyocr.Reader(self.languages, gpu=self.use_gpu)
        return self.reader

    def get_ocr_elements(self, bytes_image_data: bytes, mode: str = 'tesseract') -> Tuple[str, List[Dict]]:
        """
        Executes OCR recognization.

        Args:
            bytes_image_data (str): image in Base64 
            mode (str): 'tesseract' (faster) or 'easyocr' (more precise)。

        Returns:
            Tuple[str, List]: (textual table string, list of element details)
        """
        try:
            image = Image.open(BytesIO(bytes_image_data))
        except Exception as e:
            print(f"Error decoding or opening image: {e}")
            return "", []

        if mode == 'tesseract':
            return self._process_tesseract(image)
        elif mode == 'easyocr':
            return self._process_easyocr(image)
        else:
            raise ValueError(f"Unknown mode: {mode}. Use 'tesseract' or 'easyocr'.")

    def _process_tesseract(self, image: Image.Image) -> Tuple[str, List[Dict]]:
        """Tesseract processing"""
        data = pytesseract.image_to_data(image, output_type=Output.DICT)
        
        ocr_elements = []
        ocr_table = "Text Table (Tesseract):\nWord id\tText\n"
        ocr_id = 0

        num_boxes = len(data['text'])
        for i in range(num_boxes):
            # filter text with low confidence
            if int(data['conf'][i]) > 0 and data['text'][i].strip():
                clean_text = re.sub(r"^[^a-zA-Z0-9\s.,!?;:\-\+]+|[^a-zA-Z0-9\s.,!?;:\-\+]+$", "", data['text'][i])
                if not clean_text: continue

                ocr_table += f"{ocr_id}\t{clean_text}\n"
                
                ocr_elements.append({
                    "id": ocr_id,
                    "text": clean_text,
                    "mode": "tesseract",
                    "left": data["left"][i],
                    "top": data["top"][i],
                    "width": data["width"][i],
                    "height": data["height"][i],
                    "conf": data["conf"][i]
                })
                ocr_id += 1
        
        return ocr_table, ocr_elements

    def _process_easyocr(self, image: Image.Image) -> Tuple[str, List[Dict]]:
        """EasyOCR processing"""
        reader = self._get_easyocr_reader()
        
        image_np = np.array(image)
        
        # detail=1 means returning (bbox, text, conf)
        results = reader.readtext(image_np, detail=1, paragraph=False, width_ths=0.1)
        
        ocr_elements = []
        ocr_table = "Text Table (EasyOCR):\nWord id\tText\n"
        ocr_id = 0
        
        for (bbox, text, conf) in results:
            clean_text = re.sub(r"^[^a-zA-Z0-9\s.,!?;:\-\+]+|[^a-zA-Z0-9\s.,!?;:\-\+]+$", "", text)
            if not clean_text.strip(): continue

            # EasyOCR returns [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
            # we convert them into left, top, width, height
            (tl, tr, br, bl) = bbox
            tl = [int(v) for v in tl]
            br = [int(v) for v in br]
            
            left = min(tl[0], bl[0])
            top = min(tl[1], tr[1])
            right = max(tr[0], br[0])
            bottom = max(bl[1], br[1])
            
            width = right - left
            height = bottom - top
            # ---------------

            ocr_table += f"{ocr_id}\t{clean_text}\n"
            
            ocr_elements.append({
                "id": ocr_id,
                "text": clean_text,
                "mode": "easyocr",
                "left": left,
                "top": top,
                "width": width,
                "height": height,
                "conf": float(conf)
            })
            ocr_id += 1

        return ocr_table, ocr_elements

    @staticmethod
    def visualize_ocr_results(image_path: str, ocr_elements: List[Dict], output_path: str):
        """
        Draw bounding boxes and IDs on the original image.
        """
        try:
            image = Image.open(image_path).convert("RGB")
            draw = ImageDraw.Draw(image)

            try:
                font = ImageFont.truetype("arial.ttf", 16)
            except IOError:
                font = ImageFont.load_default()

            for element in ocr_elements:
                left, top = element["left"], element["top"]
                width, height = element["width"], element["height"]
                
                color = "green" if element.get("mode") == "easyocr" else "red"
                
                draw.rectangle([(left, top), (left + width, top + height)], outline=color, width=2)
                
                text_str = str(element["id"])
                
                if hasattr(draw, "textbbox"):
                    bbox = draw.textbbox((0, 0), text_str, font=font)
                    text_w, text_h = bbox[2]-bbox[0], bbox[3]-bbox[1]
                else:
                    text_w, text_h = draw.textsize(text_str, font=font)
                
                label_bg = [left, top - text_h - 4, left + text_w + 4, top]
                draw.rectangle(label_bg, fill=color)
                
                draw.text((left + 2, top - text_h - 4), text_str, fill="white", font=font)

            image.save(output_path)
            print(f"Visualization saved to: {output_path}")

        except FileNotFoundError:
            print(f"Error: Image {image_path} not found.")
        except Exception as e:
            print(f"Visualization error: {e}")

