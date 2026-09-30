import type { Agent, Task } from "../types";

export function buildWorkerPrompt(task: Task, agent: Agent): string {
  return `
Kamu adalah ${agent} Worker dalam AI Office.

Jangan berinteraksi dengan user secara langsung.

Task ID:
${task.id}

Project:
${task.project}

Title:
${task.title}

Task file:
${task.filePath}

## Instruksi

Kerjakan task sesuai requirement dan acceptance criteria
yang ada di task file.

Sebelum bekerja:

1. Baca task file.
2. Pahami requirement.
3. Baca acceptance criteria.
4. Periksa dependency.
5. Baca dokumentasi project yang relevan saja.
6. Ikuti System/Task-Protocol.md.

Jangan membaca seluruh vault tanpa alasan.

Jangan mengubah requirement secara diam-diam.

## Completion

Jika implementation selesai:

- jalankan test yang relevan
- pastikan acceptance criteria terpenuhi
- catat evidence pada task
- ubah status task menjadi REVIEW

Jangan menandai task DONE.

QA yang menentukan DONE.

Jika menemukan masalah yang menghalangi pekerjaan,
ikuti lifecycle task dan catat evidence dengan jelas.

Kerjakan task sekarang.
`.trim();
}

export function buildQAPrompt(task: Task): string {
  return `
Kamu adalah QA Worker dalam AI Office.

Task ID:
${task.id}

Project:
${task.project}

Title:
${task.title}

Task file:
${task.filePath}

## Instruksi

Lakukan verification terhadap task ini.

Sebelum testing:

1. Baca task.
2. Baca requirement.
3. Baca acceptance criteria.
4. Periksa implementation evidence.
5. Baca documentation yang relevan.
6. Ikuti System/Task-Protocol.md.

Periksa:

- acceptance criteria
- happy path
- edge cases
- error handling
- regression
- security impact bila relevan

Catat evidence QA pada task.

Jika PASS:

- ubah status menjadi DONE
- catat hasil verification

Jika FAIL:

- ubah status menjadi BLOCKED
- jelaskan defect
- sertakan evidence
- jangan memperbaiki implementation FE/BE

Jangan menghapus task.

Kerjakan verification sekarang.
`.trim();
}
