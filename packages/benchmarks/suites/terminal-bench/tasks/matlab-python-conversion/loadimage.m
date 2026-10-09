#!/usr/bin/octave

function I_t = loadimage(image_fld, save_fld)
  % LOADIMAGE(image_fld, save_fld)
  %   Assembles all .tif stacks in image_fld into one 3D matrix I_t
  %   and saves it to save_fld/I.mat.

  % (Uncomment if Octave image package not auto-loaded)
  % pkg load image

  % List all .tif files in the folder
  files = dir(fullfile(image_fld, '*.tif'));
  I_t = [];

  for j = 1:numel(files)
    fname = fullfile(image_fld, files(j).name);

    % Get number of slices in this TIFF stack
    info = imfinfo(fname);
    num_images = numel(info);

    % Read first slice to determine size & type
    I_sample = imread(fname, 1);
    [h, w] = size(I_sample);

    % Preallocate a 3D block of the correct class
    I_cum = cast(zeros(h, w, num_images), class(I_sample));

    fprintf('Loading tif file %d of %d: %s\n', j, numel(files), files(j).name);

    for k = 1:num_images
      I_cum(:,:,k) = imread(fname, k);
    end

    % Append to output volume
    I_t = cat(3, I_t, I_cum);
  end

  % Save result
  outname = fullfile(save_fld, 'I.mat');
  save(outname, 'I_t', '-v7');
endfunction
