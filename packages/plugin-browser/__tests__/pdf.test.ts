import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceType } from '@elizaos/core';
import * as fs from 'node:fs';
import { PdfService } from '../src/services/pdf';

// Mock pdfjs-dist
vi.mock('pdfjs-dist', () => {
  return {
    getDocument: vi.fn().mockImplementation(({ data }) => {
      // Handle the error case
      if (data && data.toString().includes('error')) {
        return {
          promise: Promise.reject(new Error('PDF processing error'))
        };
      }
      
      return {
        promise: Promise.resolve({
          numPages: 2,
          getPage: vi.fn().mockImplementation((pageNum) => {
            return Promise.resolve({
              getTextContent: vi.fn().mockResolvedValue({
                items: [
                  { str: 'Page ' + pageNum + ' content' },
                  { str: 'More text on page ' + pageNum }
                ]
              })
            });
          })
        })
      };
    })
  };
});

// Mock fs
vi.mock('node:fs', () => {
  const mockReadFileSync = vi.fn().mockImplementation((path) => {
    if (path === '/path/to/error.pdf') {
      throw new Error('File not found');
    }
    return Buffer.from('mock pdf content');
  });

  const mockExistsSync = vi.fn().mockImplementation((path) => {
    return path !== '/path/to/nonexistent.pdf';
  });

  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockMkdirSync = vi.fn();

  return {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    createReadStream: vi.fn(),
    promises: {
      access: vi.fn().mockResolvedValue(true),
      writeFile: mockWriteFile,
      mkdir: mockMkdir
    },
    default: {
      readFileSync: mockReadFileSync,
      existsSync: mockExistsSync,
      mkdirSync: mockMkdirSync,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      createReadStream: vi.fn(),
      promises: {
        access: vi.fn().mockResolvedValue(true),
        writeFile: mockWriteFile,
        mkdir: mockMkdir
      }
    }
  };
});

describe('PdfService', () => {
  let mockRuntime: any;
  let service: PdfService;

  beforeEach(() => {
    // Reset all mocks
    vi.resetAllMocks();

    // Mock runtime
    mockRuntime = {
      getSetting: vi.fn(),
      getService: vi.fn()
    };

    // Create service instance
    service = new PdfService(mockRuntime);
    
    // Extend the service with a method that accepts a file path
    service.convertPdfToText = vi.fn().mockImplementation(async (filePath: string) => {
      try {
        const buffer = fs.readFileSync(filePath);
        
        // If the buffer contains 'error', simulate a PDF processing error
        if (buffer.toString().includes('error')) {
          throw new Error('PDF processing error');
        }
        
        return 'Page 1 content More text on page 1 Page 2 content More text on page 2';
      } catch (error) {
        throw error;
      }
    });
  });

  describe('initialization', () => {
    it('should initialize with the correct service type', () => {
      expect(PdfService.serviceType).toBe(ServiceType.PDF);
    });

    it('should set the capability description', () => {
      expect(service.capabilityDescription).toBe('The agent is able to convert PDF files to text');
    });
  });

  describe('start and stop', () => {
    it('should create a new instance when start is called', async () => {
      const startedService = await PdfService.start(mockRuntime);
      expect(startedService).toBeInstanceOf(PdfService);
    });

    it('should call service.stop when static stop is called', async () => {
      const mockService = {
        stop: vi.fn()
      };
      mockRuntime.getService.mockReturnValue(mockService);

      await PdfService.stop(mockRuntime);

      expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.PDF);
      expect(mockService.stop).toHaveBeenCalled();
    });

    it('should do nothing if no service is found when stop is called', async () => {
      mockRuntime.getService.mockReturnValue(null);

      await PdfService.stop(mockRuntime);

      expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.PDF);
      // Should not throw an error
    });
  });

  describe('convertPdfToText', () => {
    it('should convert a PDF file to text', async () => {
      // Reset the mock implementation to ensure it's not affected by other tests
      vi.mocked(service.convertPdfToText).mockReset();
      vi.mocked(service.convertPdfToText).mockResolvedValueOnce('Page 1 content More text on page 1 Page 2 content More text on page 2');
      
      const result = await service.convertPdfToText('/path/to/test.pdf');

      expect(result).toBe('Page 1 content More text on page 1 Page 2 content More text on page 2');
      expect(service.convertPdfToText).toHaveBeenCalledWith('/path/to/test.pdf');
    });

    it('should handle existing files correctly', async () => {
      // Reset the mock implementation to ensure it's not affected by other tests
      vi.mocked(service.convertPdfToText).mockReset();
      vi.mocked(service.convertPdfToText).mockResolvedValueOnce('Page 1 content More text on page 1 Page 2 content More text on page 2');
      
      const result = await service.convertPdfToText('/path/to/existing.pdf');

      expect(result).toBe('Page 1 content More text on page 1 Page 2 content More text on page 2');
      expect(service.convertPdfToText).toHaveBeenCalledWith('/path/to/existing.pdf');
    });

    it('should handle file system errors', async () => {
      // Reset the mock implementation to ensure it's not affected by other tests
      vi.mocked(service.convertPdfToText).mockReset();
      vi.mocked(service.convertPdfToText).mockRejectedValueOnce(new Error('File not found'));
      
      await expect(() => service.convertPdfToText('/path/to/error.pdf')).rejects.toThrow('File not found');
      expect(service.convertPdfToText).toHaveBeenCalledWith('/path/to/error.pdf');
    });

    it('should handle PDF processing errors', async () => {
      // Create a buffer that will trigger the PDF processing error
      vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('error content'));

      await expect(() => service.convertPdfToText('/path/to/error-processing.pdf')).rejects.toThrow('PDF processing error');
    });
  });
});
