#!/usr/bin/env python3
import os
import sys
import zipfile
import tempfile
import shutil
import re
import tarfile
from pathlib import Path

def update_wheel_metadata(wheel_path):
    """Update wheel metadata to change package name from computeruse-py to computeruse"""
    print(f"Processing wheel: {wheel_path}")
    temp_dir = tempfile.mkdtemp()
    
    try:
        # Extract wheel
        with zipfile.ZipFile(wheel_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
        
        # Track if we need to update dist-info directory
        dist_info_renamed = False
        
        # First pass: rename dist-info directories
        for root, dirs, files in os.walk(temp_dir):
            for d in dirs[:]:  # Create a copy of dirs to iterate
                if d.endswith('.dist-info') and 'computeruse_py' in d:
                    old_path = os.path.join(root, d)
                    new_name = d.replace('computeruse_py', 'computeruse')
                    new_path = os.path.join(root, new_name)
                    print(f"  Renaming dist-info: {d} -> {new_name}")
                    os.rename(old_path, new_path)
                    dist_info_renamed = True
                    dirs.remove(d)
                    dirs.append(new_name)
        
        # Second pass: update metadata files
        for root, dirs, files in os.walk(temp_dir):
            # Update METADATA file
            if 'METADATA' in files:
                metadata_path = os.path.join(root, 'METADATA')
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Replace package name more carefully
                original_content = content
                # Fix the regex to be less strict - handle any whitespace and line endings
                content = re.sub(r'^Name:\s*computeruse[-_]py\s*$', 'Name: computeruse', content, flags=re.MULTILINE)
                # Also handle cases where it might not be on its own line
                content = re.sub(r'Name:\s*computeruse[-_]py\b', 'Name: computeruse', content)
                # Replace all other occurrences
                content = content.replace('computeruse-py', 'computeruse')
                content = content.replace('computeruse_py', 'computeruse')
                
                if content != original_content:
                    print(f"  Updated METADATA in {os.path.relpath(root, temp_dir)}")
                    with open(metadata_path, 'w', encoding='utf-8') as f:
                        f.write(content)
            
            # Update RECORD file
            if 'RECORD' in files:
                record_path = os.path.join(root, 'RECORD')
                with open(record_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                content = content.replace('computeruse_py', 'computeruse')
                
                with open(record_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"  Updated RECORD in {os.path.relpath(root, temp_dir)}")
            
            # Update top_level.txt if it exists
            if 'top_level.txt' in files:
                top_level_path = os.path.join(root, 'top_level.txt')
                with open(top_level_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Only update if it specifically references computeruse_py
                if 'computeruse_py' in content:
                    content = content.replace('computeruse_py', 'computeruse')
                    with open(top_level_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    print(f"  Updated top_level.txt")
        
        # Create new wheel with updated name
        new_wheel_path = wheel_path.replace('computeruse_py', 'computeruse').replace('computeruse-py', 'computeruse')
        print(f"  Creating new wheel: {new_wheel_path}")
        
        with zipfile.ZipFile(new_wheel_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(temp_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zipf.write(file_path, arcname)
        
        # Remove original wheel if different name
        if new_wheel_path != wheel_path and os.path.exists(wheel_path):
            os.remove(wheel_path)
            print(f"  Removed original wheel: {wheel_path}")
        
        print(f"[SUCCESS] Successfully processed: {os.path.basename(new_wheel_path)}")
        
    except Exception as e:
        print(f"[ERROR] Error processing {wheel_path}: {e}")
        raise
    finally:
        shutil.rmtree(temp_dir)

def update_sdist_metadata(sdist_path):
    """Update source distribution metadata to change package name from computeruse-py to computeruse"""
    print(f"Processing sdist: {sdist_path}")
    temp_dir = tempfile.mkdtemp()
    
    try:
        # Extract tarball
        with tarfile.open(sdist_path, 'r:gz') as tar:
            tar.extractall(temp_dir)
        
        # Find the extracted directory
        extracted_dirs = [d for d in os.listdir(temp_dir) if os.path.isdir(os.path.join(temp_dir, d))]
        if not extracted_dirs:
            print(f"  No directory found in {sdist_path}")
            return
        
        old_dir_name = extracted_dirs[0]
        old_dir_path = os.path.join(temp_dir, old_dir_name)
        
        # Update all metadata files
        for root, dirs, files in os.walk(old_dir_path):
            for file in files:
                file_path = os.path.join(root, file)
                
                # Update pyproject.toml
                if file == 'pyproject.toml':
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    content = re.sub(r'name\s*=\s*["\']computeruse[-_]py["\']', 'name = "computeruse"', content)
                    content = content.replace('computeruse-py', 'computeruse')
                    content = content.replace('computeruse_py', 'computeruse')
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    print(f"  Updated pyproject.toml")
                
                # Update PKG-INFO
                elif file == 'PKG-INFO':
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    content = re.sub(r'^Name:\s*computeruse[-_]py\s*$', 'Name: computeruse', content, flags=re.MULTILINE)
                    content = content.replace('computeruse-py', 'computeruse')
                    content = content.replace('computeruse_py', 'computeruse')
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    print(f"  Updated PKG-INFO")
                
                # Update any .egg-info metadata
                elif file == 'METADATA':
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    content = re.sub(r'^Name:\s*computeruse[-_]py\s*$', 'Name: computeruse', content, flags=re.MULTILINE)
                    content = content.replace('computeruse-py', 'computeruse')
                    content = content.replace('computeruse_py', 'computeruse')
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    print(f"  Updated METADATA")
        
        # Rename the directory
        new_dir_name = old_dir_name.replace('computeruse-py', 'computeruse').replace('computeruse_py', 'computeruse')
        new_dir_path = os.path.join(temp_dir, new_dir_name)
        if new_dir_name != old_dir_name:
            os.rename(old_dir_path, new_dir_path)
            print(f"  Renamed directory: {old_dir_name} -> {new_dir_name}")
        
        # Create new tarball with updated name
        new_sdist_path = sdist_path.replace('computeruse-py', 'computeruse').replace('computeruse_py', 'computeruse')
        print(f"  Creating new sdist: {new_sdist_path}")
        
        with tarfile.open(new_sdist_path, 'w:gz') as tar:
            tar.add(new_dir_path, arcname=new_dir_name)
        
        # Remove original sdist if different name
        if new_sdist_path != sdist_path and os.path.exists(sdist_path):
            os.remove(sdist_path)
            print(f"  Removed original sdist: {sdist_path}")
        
        print(f"[SUCCESS] Successfully processed: {os.path.basename(new_sdist_path)}")
        
    except Exception as e:
        print(f"[ERROR] Error processing {sdist_path}: {e}")
        raise
    finally:
        shutil.rmtree(temp_dir)

def main():
    # Process all wheels and sdists in current directory
    wheels_found = list(Path('.').glob('*.whl'))
    sdists_found = list(Path('.').glob('*.tar.gz'))
    
    if not wheels_found and not sdists_found:
        print("No wheel or sdist files found in current directory")
        return
    
    if wheels_found:
        print(f"Found {len(wheels_found)} wheel file(s)")
        for wheel_file in wheels_found:
            wheel_name = str(wheel_file)
            if 'computeruse_py' in wheel_name or 'computeruse-py' in wheel_name:
                update_wheel_metadata(wheel_name)
            else:
                print(f"Skipping {wheel_name} - already using 'computeruse' name")
    
    if sdists_found:
        print(f"Found {len(sdists_found)} sdist file(s)")
        for sdist_file in sdists_found:
            sdist_name = str(sdist_file)
            if 'computeruse-py' in sdist_name or 'computeruse_py' in sdist_name:
                update_sdist_metadata(sdist_name)
            else:
                print(f"Skipping {sdist_name} - already using 'computeruse' name")

if __name__ == '__main__':
    main()