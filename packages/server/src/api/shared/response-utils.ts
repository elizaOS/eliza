import express from 'express';

/**
 * Sends a standardized error response
 */
export const sendError = (
  res: express.Response,
  status: number,
  code: string,
  message: string,
  details?: string
) => {
  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  });
};

/**
 * Sends a standardized success response
 */
export const sendSuccess = (res: express.Response, data: any, status = 200) => {
  res.status(status).json({
    success: true,
    data,
  });
};
