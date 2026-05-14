use Test::Spec;

use 5.10.1;
use Data::Dumper;
use File::Temp qw{tempdir tempfile};
use Path::Tiny;
use Tails::IUK::Utils qw{extract_file_from_iso};
use Test::Fatal qw{dies_ok};

my @genisoimage_opts = qw{--quiet -J -l -cache-inodes -allow-multidot};
my @genisoimage = ('genisoimage', @genisoimage_opts);

describe 'The extract_file_from_iso function' => sub {
    describe 'when run on a non-existing ISO' => sub {
        it 'throws an exception' => sub {
            dies_ok { extract_file_from_iso(path('bla'), path('non-existing.iso')) };
        };
    };
    describe 'when asked to extract a non-existing file from an ISO' => sub {
        my $iso;
        before sub {
            my $tempdir = tempdir(CLEANUP => 1);
            $iso = path($tempdir, 'test.iso');
            my $iso_tempdir = tempdir(CLEANUP => 1);
            system(@genisoimage, "-o", $iso, $iso_tempdir);
        };
        it 'throws an exception' => sub {
            dies_ok { extract_file_from_iso(path('non-existing.file'), $iso) };
        };
    };
    describe 'when asked to extract an existing file from an ISO' => sub {
        my $iso;
        my $known_content = "known content";
        before sub {
            my $tempdir = tempdir(CLEANUP => 1);
            $iso = path($tempdir, 'test.iso');
            my $iso_tempdir = tempdir(CLEANUP => 1);
            path($iso_tempdir, 'vmlinuz')->spew($known_content);
            system(@genisoimage, "-o", $iso, $iso_tempdir);
        };
        it 'returns the file content' => sub {
            is(extract_file_from_iso(path('vmlinuz'), $iso), $known_content);
        };
    };
};

runtests unless caller;
