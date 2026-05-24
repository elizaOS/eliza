# Copyright 2013-2016 Tails developers <foundations@tails.net>
#
# This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>
#
"""Tails Greeter exceptions

"""


class TailsGreeterError(Exception):
    pass


class PersistentStorageError(TailsGreeterError):
    pass


class FeatureActivationFailedError(PersistentStorageError):
    pass


class WrongPassphraseError(PersistentStorageError):
    pass


class FilesystemErrorsLeftUncorrectedError(PersistentStorageError):
    pass


class IOErrorsDetectedError(PersistentStorageError):
    pass


class GdmServerError(TailsGreeterError):
    pass
