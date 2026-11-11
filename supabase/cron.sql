-- Dagelijkse automatische import (optioneel).
-- Voer dit uit in de Supabase SQL Editor NADAT je de Edge Function hebt gedeployd.
--
-- Vervang vooraf:
--   <PROJECT-REF>     door je project-ref (het stuk vóór .supabase.co in je project-URL)
--   <IMPORT-SECRET>   door dezelfde waarde die je als secret IMPORT_SECRET hebt ingesteld
--
-- De geheimen worden in Supabase Vault opgeslagen, niet als platte tekst in de cron-taak.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://<PROJECT-REF>.supabase.co', 'kvq_project_url');
select vault.create_secret('<IMPORT-SECRET>', 'kvq_import_secret');

-- Elke dag om 06:17 UTC
select cron.schedule(
  'kamervragen-import',
  '17 6 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'kvq_project_url') || '/functions/v1/import-kamervragen',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-import-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kvq_import_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- Controleren:      select * from cron.job;
-- Laatste runs:     select * from cron.job_run_details order by start_time desc limit 5;
-- Stoppen:          select cron.unschedule('kamervragen-import');
