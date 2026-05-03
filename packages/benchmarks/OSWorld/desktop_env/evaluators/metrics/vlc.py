import logging
import os
import subprocess
from typing import Dict
from xml.etree import ElementTree
from urllib.parse import urlparse

import acoustid
import cv2
import imagehash
import librosa
import numpy as np
from PIL import Image
from fastdtw import fastdtw
from scipy.spatial.distance import cosine
from skimage.metrics import structural_similarity as ssim

logger = logging.getLogger("desktopenv.metrics.vlc")


def is_vlc_playing(actual_status_path: str, rule: Dict[str, str]) -> float:
    """
    Checks if VLC is currently playing a file.
    """
    with open(actual_status_path, 'rb') as file:
        actual_status = file.read().decode('utf-8')

    tree = ElementTree.fromstring(actual_status)
    status = tree.find('state').text
    logger.info(f"VLC Status: {status}")
    if status == 'playing':
        if rule['type'] == 'file_name':
            # Try multiple possible paths for file information in VLC XML
            file_paths = [
                'information/category[@name="meta"]/info[@name="filename"]',
                'information/category[@name="meta"]/info[@name="title"]',
                'information/category[@name="meta"]/info[@name="uri"]',
                'information/category[@name="meta"]/info[@name="location"]',
                'information/category[@name="meta"]/info[@name="name"]'
            ]
            
            file_info = None
            for path in file_paths:
                element = tree.find(path)
                if element is not None and element.text:
                    file_info = element.text
                    break
            
            if file_info:
                expected_filename = rule['file_name']
                
                # Method 1: Direct filename match (most precise)
                actual_basename = os.path.basename(file_info)
                if actual_basename == expected_filename:
                    return 1
                
                # Method 2: Endswith match (for backward compatibility)
                if file_info.endswith(expected_filename):
                    return 1
                
                # Method 3: For paths, check if expected filename is in the path
                if expected_filename in file_info:
                    # Additional check to avoid false positives
                    # Make sure it's actually the filename, not just part of a path
                    if file_info.endswith('/' + expected_filename) or file_info.endswith('\\' + expected_filename):
                        return 1
                
                logger.warning(f"File name mismatch - Expected: {expected_filename}, Found: {file_info}")
                return 0
            else:
                logger.warning(f"Could not find file information in VLC status XML for rule: {rule}")
                return 0
        elif rule['type'] == 'url':
            # Try multiple possible paths for URL information in VLC XML
            url_paths = [
                'information/category[@name="meta"]/info[@name="url"]',
                'information/category[@name="meta"]/info[@name="URI"]', 
                'information/category[@name="meta"]/info[@name="location"]',
                'information/category[@name="meta"]/info[@name="title"]',  # Sometimes URL is in title for streams
                'information/category[@name="meta"]/info[@name="filename"]',  # Sometimes URL is in filename for streams
                'information/category[@name="Stream 0"]/info[@name="Codec"]',  # Try stream info
                'information/category[@name="Stream 0"]/info[@name="Type"]',
                'information/category[@name="Stream 0"]/info[@name="Language"]'
            ]
            
            file_info = None
            logger.debug(f"Looking for URL: {rule['url']}")
            
            for path in url_paths:
                element = tree.find(path)
                if element is not None and element.text:
                    file_info = element.text
                    logger.debug(f"Found URL info at '{path}': {file_info}")
                    break
            
            if file_info:
                # For URL comparison, check if the rule URL is contained in the file_info
                # This handles cases where VLC might show a longer or modified URL
                expected_url = rule['url']
                
                # Method 1: Direct URL match
                if expected_url in file_info or file_info.endswith(expected_url):
                    return 1
                
                # Method 2: For HLS streams, VLC often shows just the filename instead of full URL
                # Check if the file_info matches the filename part of the expected URL
                try:
                    expected_parsed = urlparse(expected_url)
                    expected_filename = os.path.basename(expected_parsed.path)
                    
                    # If VLC shows just the filename (common for HLS streams)
                    if file_info == expected_filename:
                        logger.info(f"URL filename match - Expected URL: {expected_url}, VLC shows filename: {file_info}")
                        return 1
                    
                    # Method 3: Check if both are URLs from the same domain and similar path
                    if '://' in file_info:  # file_info is also a URL
                        actual_parsed = urlparse(file_info)
                        # Same domain and similar path structure
                        if (expected_parsed.netloc == actual_parsed.netloc and 
                            expected_parsed.path in actual_parsed.path):
                            return 1
                except Exception as e:
                    logger.debug(f"URL parsing error: {e}")
                    pass
                
                logger.warning(f"URL mismatch - Expected: {expected_url}, Found: {file_info}")
                return 0
            else:
                logger.warning(f"Could not find URL information in VLC status XML for rule: {rule}")
                return 0
        else:
            logger.error(f"Unknown type: {rule['type']}")
            return 0
    else:
        return 0


# fixme: part of this function can be moved to getters
def is_vlc_recordings_folder(actual_config_path: str, rule: Dict[str, str]) -> float:
    """
    Checks if VLC's recording folder is set to the expected value.
    """
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_recording_file_path = rule['recording_file_path']

    try:
        for line in config_file.split("\n"):
            # Skip comments and empty lines
            if line.startswith('#') or not line.strip():
                continue
            # Check if the line contains the recording path setting
            if 'input-record-path' in line:
                # Extract the value of the recording path and remove surrounding whitespace
                current_path = line.split('=')[-1].strip()
                # Compare with the Desktop path
                if current_path == expected_recording_file_path:
                    return 1
                else:
                    return 0
        # The configuration key was not found in the file
        return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def is_vlc_fullscreen(actual_window_size, screen_size):
    if screen_size is None or actual_window_size is None:
        # if the screen size is not available, means that the window is not fullscreen
        return 0

    if actual_window_size['width'] == screen_size['width'] and actual_window_size['height'] == screen_size['height']:
        return 1
    else:
        return 0


def compare_images(image1_path, image2_path, **options):
    # You would call this function with the paths to the two images you want to compare:
    # score = compare_images('path_to_image1', 'path_to_image2')
    # print("Similarity score:", score)

    if not image1_path or not image2_path:
        return 0

    base_score = options.get("reference_base_result", None)

    # Open the images and convert to grayscale
    image1 = Image.open(image1_path).convert('L')
    image2 = Image.open(image2_path).convert('L')

    # Resize images to the smaller one's size for comparison
    image1_size = image1.size
    image2_size = image2.size
    new_size = min(image1_size, image2_size)

    image1 = image1.resize(new_size, Image.Resampling.LANCZOS)
    image2 = image2.resize(new_size, Image.Resampling.LANCZOS)

    # Convert images to numpy arrays
    image1_array = np.array(image1)
    image2_array = np.array(image2)

    # Calculate SSIM between two images
    similarity_index = ssim(image1_array, image2_array)

    epsilon = 0.01
    if base_score is not None:
        if similarity_index >= base_score + epsilon:
            return (similarity_index - base_score) / (1 - base_score)
        else:
            return 0
    else:
        return similarity_index

def compare_audios(audio_path_1, audio_path_2):
    """
    Compare two audio files and return a similarity score in the range [0, 1].
    audio_path_1, audio_path_2: paths to the audio files to compare
    """
    # similarity = compare_audios_simple('path_to_audio1.mp3', 'path_to_audio2.mp3')
    # print(f'Similarity Score: {similarity}')

    if not audio_path_1 or not audio_path_2:
        return 0

    y1, y2 = None, None
    try:
        y1, sr1 = librosa.load(audio_path_1)
    except Exception:
        logger.warning(f"Could not load audio from {os.path.basename(audio_path_1)}. It might be empty or corrupt.")

    try:
        y2, sr2 = librosa.load(audio_path_2)
    except Exception:
        logger.warning(f"Could not load audio from {os.path.basename(audio_path_2)}. It might be empty or corrupt.")

    # Handle cases where one or both audio files are empty or corrupt.
    is_y1_bad = (y1 is None) or (y1.shape[0] == 0)
    is_y2_bad = (y2 is None) or (y2.shape[0] == 0)

    if is_y1_bad and is_y2_bad:
        logger.info("Both audio files are empty or corrupt. Considering them perfectly similar.")
        return 1.0
    
    if is_y1_bad or is_y2_bad:
        logger.warning(f"One audio file is empty/corrupt, the other is not. Similarity is 0.")
        return 0.0

    try:
        logger.info(f"Audio 1 ({os.path.basename(audio_path_1)}): sr={sr1}, len={len(y1)}")
        logger.info(f"Audio 2 ({os.path.basename(audio_path_2)}): sr={sr2}, len={len(y2)}")

        # Extract MFCC features
        mfcc1 = librosa.feature.mfcc(y=y1, sr=sr1)
        mfcc2 = librosa.feature.mfcc(y=y2, sr=sr2)
    except Exception as e:
        logger.error(f"Error during MFCC extraction: {e}")
        return 0.0

    # Normalize the MFCC features
    mfcc1 = librosa.util.normalize(mfcc1, axis=1)
    mfcc2 = librosa.util.normalize(mfcc2, axis=1)
    logger.info(f"MFCCs normalized.")

    # Define a lambda function to compute cosine distance
    dist_func = lambda x, y: cosine(x, y)

    # Use the DTW algorithm to find the best alignment path
    distance, path = fastdtw(mfcc1.T, mfcc2.T, dist=dist_func)
    logger.info(f"DTW distance: {distance:.4f}, Path length: {len(path)}")

    # Normalize the DTW distance by the length of the alignment path.
    if len(path) == 0:
        normalized_distance = np.inf
    else:
        normalized_distance = distance / len(path)
    logger.info(f"Normalized DTW distance: {normalized_distance:.4f}")
    
    # Convert the normalized distance to a similarity score using an exponential decay function.
    similarity = np.exp(-normalized_distance)

    return similarity


def compare_audios_by_dl_model(audio_path_1, audio_path_2):
    pass


def compare_videos(video_path1, video_path2, max_frames_to_check=100, threshold=5):
    # Open both video files
    cap1 = cv2.VideoCapture(video_path1)
    cap2 = cv2.VideoCapture(video_path2)

    frames_checked = 0
    mismatch_count = 0

    while frames_checked < max_frames_to_check:
        # Read frames from both videos
        ret1, frame1 = cap1.read()
        ret2, frame2 = cap2.read()

        # If a video ends, then check if both ended to confirm they are of the same length
        if not ret1 or not ret2:
            return 1. if ret1 == ret2 else 0. # return float only 

        # Convert frames to PIL Images
        frame1 = Image.fromarray(cv2.cvtColor(frame1, cv2.COLOR_BGR2RGB))
        frame2 = Image.fromarray(cv2.cvtColor(frame2, cv2.COLOR_BGR2RGB))

        # Compute the perceptual hash for each frame
        hash1 = imagehash.phash(frame1)
        hash2 = imagehash.phash(frame2)

        # Increment the frames checked
        frames_checked += 1

        # Compute the difference in the hashes
        if hash1 - hash2 > threshold:
            mismatch_count += 1
            # If there's a significant difference, the frames are not the same
            if mismatch_count > threshold:
                return 0.

    # If we reach here, the content appears to be the same
    return 1.


def check_qt_bgcone(actual_config_path, rule):
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_qt_bgcone = rule['expected_qt_bgcone']
    if isinstance(expected_qt_bgcone, int):
        expected_qt_bgcone = str(expected_qt_bgcone)

    try:
        # The default value of qt_bgcone is 1, which means it is enabled
        qt_bgcone = "1"
        for line in config_file.split("\n"):
            # Check if the line contains the recording path setting
            if 'qt-bgcone=' in line:
                # Extract the value of the recording path and remove surrounding whitespace
                qt_bgcone = line.split('=')[-1].strip()
            # The configuration key was not found in the file

        if qt_bgcone == expected_qt_bgcone:
            return 1
        else:
            return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def check_qt_max_volume(actual_config_path, rule):
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_qt_max_volume = rule['expected_qt_max_volume']
    if isinstance(expected_qt_max_volume, int):
        expected_qt_max_volume = str(expected_qt_max_volume)

    try:
        qt_max_volume = "125"
        for line in config_file.split("\n"):
            if 'qt-max-volume=' in line:
                qt_max_volume = line.split('=')[-1].strip()
            # The configuration key was not found in the file

        if qt_max_volume == expected_qt_max_volume:
            return 1
        else:
            return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def check_qt_minimal_view(actual_config_path, rule):
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_qt_minimal_view = rule['expected_qt_minimal_view']
    if isinstance(expected_qt_minimal_view, int):
        expected_qt_minimal_view = str(expected_qt_minimal_view)

    try:
        qt_minimal_view = "0"
        for line in config_file.split("\n"):
            if 'qt-minimal-view=' in line:
                qt_minimal_view = line.split('=')[-1].strip()

        if qt_minimal_view == expected_qt_minimal_view:
            return 1
        else:
            return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def check_qt_slider_colours(actual_config_path, rule):
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    try:
        qt_slider_colours = "153;210;153;20;210;20;255;199;15;245;39;29"
        for line in config_file.split("\n"):
            if 'qt-slider-colours' in line:
                qt_slider_colours = line.split('=')[-1].strip()
            # The configuration key was not found in the file

        if rule['type'] == 'match':
            expected_qt_slider_colours = rule['expected_qt_slider_colours']
            if qt_slider_colours == expected_qt_slider_colours:
                return 1
            else:
                return 0
        elif rule['type'] == 'blackish':
            def is_color_blackish(rgb_values, threshold=100):
                # decide if the color is blackish
                return all(value < threshold for value in rgb_values)

            def parse_qt_slider_colours(colours_string):
                # parse the string of colours into a list of RGB tuples
                values = [int(x) for x in colours_string.split(';')]
                colors = list(zip(values[0::3], values[1::3], values[2::3]))
                return colors

            colors = parse_qt_slider_colours(qt_slider_colours)

            # check if all colors are blackish
            for color in colors:
                if is_color_blackish(color):
                    pass
                else:
                    return 0
            return 1

    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def check_global_key_play_pause(actual_config_path, rule):
    """
    # Play/Pause (str)
    #global-key-play-pause=

    # Play/Pause (str)
    #key-play-pause=Space
    """
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_global_key_play_pause = rule['expected_global_key_play_pause']

    if isinstance(expected_global_key_play_pause, int):
        expected_global_key_play_pause = str(expected_global_key_play_pause)

    try:
        global_key_play_pause = "0"
        for line in config_file.split("\n"):
            # Check if the line contains the recording path setting
            if 'global-key-play-pause=' in line:
                global_key_play_pause = "0" if line.split('=')[-1].strip() == "" else "1"

        if global_key_play_pause == expected_global_key_play_pause:
            return 1
        else:
            return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0


def check_one_instance_when_started_from_file(actual_config_path, rule):
    with open(actual_config_path, 'rb') as file:
        config_file = file.read().decode('utf-8')

    expected_one_instance_when_started_from_file = rule['expected_one_instance_when_started_from_file']

    if isinstance(expected_one_instance_when_started_from_file, int):
        expected_one_instance_when_started_from_file = str(expected_one_instance_when_started_from_file)

    try:
        one_instance_when_started_from_file = "1"
        for line in config_file.split("\n"):
            # Check if the line contains the recording path setting
            if 'one-instance-when-started-from-file=' in line:
                one_instance_when_started_from_file = line.split('=')[-1].strip()

        if one_instance_when_started_from_file == expected_one_instance_when_started_from_file:
            return 1
        else:
            return 0
    except FileNotFoundError:
        logger.error("VLC configuration file not found.")
        return 0
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        return 0
