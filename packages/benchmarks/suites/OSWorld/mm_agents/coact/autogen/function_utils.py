# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from logging import getLogger

from .tools import get_function_schema, load_basemodels_if_needed, serialize_to_str

__all__ = ["get_function_schema", "load_basemodels_if_needed", "serialize_to_str"]

logger = getLogger(__name__)

logger.info("Importing from 'autogen.function_utils' is deprecated, import from 'autogen.tools' instead.")
