package Test::WebServer::Static::SSL::RedirectToHTTP;

use strictures 2;
use Carp::Assert;

use parent qw{Test::WebServer::Static::SSL};

sub handle_request {
    my ($self, $cgi) = @_;

    for (qw{target target_port}) {
        assert(exists  $self->{$_});
        assert(defined $self->{$_});
    }

    print "HTTP/1.0 301 Moved Permanently\r\n";
    print sprintf(
        "Location: http://%s:%d%s\r\n",
        $self->{target}, $self->{target_port}, $cgi->path_info()
    );
}

1;
